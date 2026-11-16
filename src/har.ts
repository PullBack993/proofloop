// Recorded traffic → probes. Takes a HAR export from a test or staging session, keeps the
// requests to the app's API, removes secrets and personal data, and writes probe definitions.
import type { ApiProbe, Config, Json } from './types.js';
import { readJson } from './util.js';
import { redactJson, redactText } from './redact.js';

interface Har {
  log: { entries: { request: { method: string; url: string; postData?: { mimeType?: string; text?: string } }; response: { status: number; content?: { mimeType?: string } } }[] };
}

// Request headers are never copied: credentials come from the configured role at replay time.

export function harToProbes(file: string, config: Config, opts: { prefix?: string; includeWrites?: boolean; pathPrefix?: string }): { probes: ApiProbe[]; skipped: string[] } {
  const har = readJson<Har>(file);
  const origin = new URL(config.app.baseUrl);
  const seen = new Set<string>();
  const probes: ApiProbe[] = [];
  const skipped: string[] = [];
  for (const e of har.log.entries) {
    let url: URL;
    try {
      url = new URL(e.request.url);
    } catch {
      continue;
    }
    const method = e.request.method.toUpperCase();
    const isApi = /json/.test(e.response.content?.mimeType ?? '') || url.pathname.startsWith(opts.pathPrefix ?? '/api');
    if (!isApi) continue;
    const path = url.pathname + url.search;
    const key = `${method} ${path} ${e.request.postData?.text ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (method !== 'GET' && !opts.includeWrites) {
      skipped.push(`${method} ${path} (write; use --include-writes and mark it as a critical journey)`);
      continue;
    }
    let body: Json | undefined;
    if (e.request.postData?.text) {
      try {
        body = redactJson(JSON.parse(e.request.postData.text) as Json);
      } catch {
        body = redactText(e.request.postData.text);
      }
    }
    const id = `${opts.prefix ?? 'rec'}.${method.toLowerCase()}.${url.pathname.replace(/^\//, '').replace(/[^\w]+/g, '.') || 'root'}${url.search ? '.q' + probes.length : ''}`;
    probes.push({
      id,
      kind: 'api',
      method,
      path: redactText(path),
      body,
      source: 'recorded',
      role: config.defaultRole,
      fixture: 'default',
      mutates: method !== 'GET' ? true : undefined,
      coverageLimit: `recorded from ${url.host === origin.host ? 'this app' : url.host}; replays one request with role ${config.defaultRole ?? 'anonymous'}`,
    });
  }
  return { probes, skipped };
}
