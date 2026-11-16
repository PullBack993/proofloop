// Load-assignment demo service: JSON API plus a server-rendered dispatcher dashboard.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { assignLoad, formatWeight, getLoad, listDrivers, listLoads } from './loads.mjs';

const db = new DatabaseSync(new URL('../data/app.db', import.meta.url).pathname);
const port = Number(process.env.PORT ?? 4317);
const routes = [];
const route = (method, path, handler) => routes.push({ method, parts: path.split('/'), handler });

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const html = (res, status, title, body) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;color:#1d2433}table{border-collapse:collapse}
td,th{border:1px solid #c9ced8;padding:6px 10px;text-align:left}th{background:#eef1f6}
.open{color:#0a6b2d}.assigned{color:#6b4a0a}</style></head><body><main>${body}</main></body></html>`);
};
const readBody = async (req) => {
  let data = '';
  for await (const c of req) data += c;
  return data ? JSON.parse(data) : {};
};

route('GET', '/health', (req, res) => json(res, 200, { ok: true }));
route('GET', '/api/loads', (req, res) => json(res, 200, listLoads(db)));
route('GET', '/api/loads/:id', (req, res, p) => {
  const load = getLoad(db, p.id);
  return load ? json(res, 200, load) : json(res, 404, { error: 'not found' });
});
route('GET', '/api/drivers', (req, res) => json(res, 200, listDrivers(db)));
route('POST', '/api/loads/:id/assign', async (req, res, p) => {
  if (req.headers['x-role'] !== 'dispatcher') return json(res, 403, { error: 'dispatchers only' });
  const { driverId } = await readBody(req);
  const r = assignLoad(db, p.id, driverId);
  return json(res, r.status, r.body);
});
route('GET', '/', (req, res) => {
  const rows = listLoads(db)
    .map((l) => `<tr><td><a href="/loads/${l.id}">${l.id}</a></td><td>${l.origin} → ${l.destination}</td><td>${formatWeight(l.weightKg)}</td><td class="${l.status}">${l.status}</td><td>${l.driverId ?? '—'}</td></tr>`)
    .join('');
  html(res, 200, 'Dispatch board', `<h1>Dispatch board</h1><table><thead><tr><th>Load</th><th>Route</th><th>Weight</th><th>Status</th><th>Driver</th></tr></thead><tbody>${rows}</tbody></table>`);
});
route('GET', '/loads/:id', (req, res, p) => {
  const l = getLoad(db, p.id);
  if (!l) return html(res, 404, 'Not found', '<h1>Load not found</h1>');
  html(res, 200, `Load ${l.id}`, `<h1>Load ${l.id}</h1><dl><dt>Route</dt><dd>${l.origin} → ${l.destination}</dd><dt>Weight</dt><dd>${formatWeight(l.weightKg)}</dd><dt>Status</dt><dd>${l.status}</dd><dt>Created</dt><dd>${l.createdAt}</dd></dl><p><a href="/">Back to board</a></p>`);
});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/');
  for (const r of routes) {
    if (r.method !== req.method || r.parts.length !== parts.length) continue;
    const params = {};
    if (r.parts.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) {
      try {
        return await r.handler(req, res, params, url);
      } catch (e) {
        return json(res, 500, { error: String(e.message ?? e) });
      }
    }
  }
  json(res, 404, { error: 'no route' });
}).listen(port, '127.0.0.1', () => console.log(`loads-app listening on ${port}`));
