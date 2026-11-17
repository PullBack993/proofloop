// Route and API inventory from router files, OpenAPI schemas and file-based page routing.
// Probes generated from it cost nothing to maintain: they are regenerated on every snapshot.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ApiProbe, BrowserProbe, Config, InventoryReport, Probe, RouteEntry } from './types.js';
import { expandPath } from './probes.js';
import { readJson } from './util.js';

const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|vue)$/;
const DEFAULT_EXCLUDE = ['node_modules', 'dist', 'build', '.git', '.next', '.nuxt', '.output', 'coverage', '.proofloop', 'test', 'tests', '__tests__'];
const METHODS = 'get|post|put|patch|delete';

const PATTERNS: RegExp[] = [
  // express / fastify / hono / koa-router: app.get('/x', ...)
  new RegExp(`\\b[A-Za-z_$][\\w$]*\\.(${METHODS})\\(\\s*['"\`](/[^'"\`]*)['"\`]`, 'gi'),
  // route tables: route('GET', '/x', ...) or { method: 'GET', path: '/x' }
  new RegExp(`['"](${METHODS})['"]\\s*,\\s*['"\`](/[^'"\`]*)['"\`]`, 'gi'),
  new RegExp(`method:\\s*['"](${METHODS})['"]\\s*,\\s*(?:path|url):\\s*['"\`](/[^'"\`]*)['"\`]`, 'gi'),
];

function walk(dir: string, exclude: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (exclude.includes(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exclude, out);
    else if (CODE_EXT.test(name)) out.push(p);
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export function discoverRoutes(config: Config, workspace: string): RouteEntry[] {
  const appDir = join(workspace, config.app.cwd ?? '.');
  const inv = config.inventory ?? {};
  const exclude = [...DEFAULT_EXCLUDE, ...(inv.exclude ?? [])];
  const apiPrefix = '/api';
  const routes = new Map<string, RouteEntry>();
  const add = (r: RouteEntry) => {
    const key = `${r.method} ${r.path}`;
    if (!routes.has(key)) routes.set(key, r);
  };
  for (const src of inv.sources ?? ['.']) {
    for (const file of walk(join(appDir, src), exclude)) {
      const text = readFileSync(file, 'utf8');
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const method = m[1].toUpperCase();
          const path = m[2];
          const kind = method === 'GET' && !path.startsWith(apiPrefix) && !/health|ready|live|metrics/.test(path) && !/\.\w+$/.test(path) ? 'page' : 'api';
          add({ method, path, kind, file: relative(workspace, file), line: lineOf(text, m.index) });
        }
      }
    }
  }
  // An absolute spec path keeps the route list fixed across the commits being compared.
  const specFile = inv.openapi ? (isAbsolute(inv.openapi) ? inv.openapi : join(appDir, inv.openapi)) : undefined;
  if (specFile && existsSync(specFile)) {
    const spec = readJson<{ paths?: Record<string, Record<string, unknown>> }>(specFile);
    for (const [path, ops] of Object.entries(spec.paths ?? {}))
      for (const method of Object.keys(ops))
        if (new RegExp(`^(${METHODS})$`, 'i').test(method))
          add({ method: method.toUpperCase(), path: path.replace(/\{(\w+)\}/g, ':$1'), kind: 'api', file: inv.openapi! });
  }
  for (const pagesDir of inv.pagesDirs ?? []) {
    const base = join(appDir, pagesDir);
    for (const file of walk(base, DEFAULT_EXCLUDE.filter((x) => x !== 'test'))) {
      let rel = relative(base, file).split(sep).join('/').replace(CODE_EXT, '');
      if (rel.startsWith('api/')) continue;
      rel = rel.replace(/(^|\/)(index|page)$/, '').replace(/\[(\w+)\]/g, ':$1').replace(/\([^)]*\)\//g, '');
      if (rel.startsWith('_') || /\/_/.test(rel) || /^layout|\/layout$/.test(rel)) continue;
      add({ method: 'GET', path: '/' + rel, kind: 'page', file: relative(workspace, file) });
    }
  }
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function routeRegex(path: string): RegExp {
  const parts = path
    .split('/')
    .map((seg) => (/^(:\w+|\[\w+\]|\{\w+\})$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('/')}/?$`);
}

function probeMethodPath(p: Probe, config: Config): { method: string; path: string } | undefined {
  if (p.route) return p.route;
  if (p.kind === 'api') return { method: p.method.toUpperCase(), path: expandPath(p.path, config).split('?')[0] };
  if (p.kind === 'browser') return { method: 'GET', path: expandPath(p.path, config).split('?')[0] };
  return undefined;
}

function slug(path: string): string {
  return path.replace(/^\//, '').replace(/[/:{}[\]]+/g, '.').replace(/\.+$/, '') || 'root';
}

/** Generates read-only probes for routes nothing else covers and reports coverage. */
export function buildInventory(config: Config, workspace: string, existing: Probe[]): { generated: Probe[]; report: InventoryReport } {
  const routes = discoverRoutes(config, workspace);
  const generate = config.inventory?.generate !== false;
  const browserOn = config.browser?.enabled !== false;
  const generated: Probe[] = [];
  const probed: InventoryReport['probed'] = [];
  const unprobed: InventoryReport['unprobed'] = [];
  for (const route of routes) {
    const re = routeRegex(route.path);
    const covering = existing.filter((p) => {
      const mp = probeMethodPath(p, config);
      return mp && mp.method === route.method && (mp.path === route.path || re.test(mp.path));
    });
    if (covering.length) {
      probed.push({ route, probes: covering.map((p) => p.id) });
      continue;
    }
    const expanded = expandPath(route.path, config);
    const missing = /:\w+|\[\w+\]|\{\w+\}/.exec(expanded);
    let reason: string | undefined;
    if (!generate) reason = 'probe generation disabled';
    else if (route.method !== 'GET') reason = 'writes need a hand-written critical-journey probe (generated probes are read-only)';
    else if (missing) reason = `no fixture value for ${missing[0]} in config.routeParams or config.params`;
    else if (route.kind === 'page' && !browserOn) reason = 'browser capture disabled';
    if (reason) {
      unprobed.push({ route, reason });
      continue;
    }
    const roles: (string | undefined)[] = route.kind === 'api' && config.inventory?.roles?.length ? config.inventory.roles : [config.defaultRole];
    const ids: string[] = [];
    roles.forEach((role, i) => {
      const suffix = i === 0 ? '' : `@${role}`;
      const limit = `generated from ${route.file}${route.line ? ':' + route.line : ''}; GET only, role ${role ?? 'anonymous'}, default fixture, no interactions`;
      const probe: ApiProbe | BrowserProbe =
        route.kind === 'page'
          ? { id: `gen.page.${slug(route.path)}${suffix}`, kind: 'browser', path: route.path, source: 'generated', role, fixture: 'default', coverageLimit: limit, route: { method: 'GET', path: route.path } }
          : { id: `gen.get.${slug(route.path)}${suffix}`, kind: 'api', method: 'GET', path: route.path, source: 'generated', role, fixture: 'default', coverageLimit: limit, route: { method: 'GET', path: route.path } };
      generated.push(probe);
      ids.push(probe.id);
    });
    probed.push({ route, probes: ids });
  }
  return { generated, report: { routes, probed, unprobed } };
}
