// Removes secrets and personal data before anything is stored as evidence or reported.
import type { Json } from './types.js';

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|private[-_]?key|credential/i;

const PATTERNS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted:jwt>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted:aws-key>'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '<redacted:api-key>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted:github-token>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted:private-key>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted:email>'],
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d) ? '<redacted:card>' : m;
  });
  return out;
}

export function redactJson(value: Json, key?: string): Json {
  if (key && SECRET_KEY.test(key) && value !== null && typeof value !== 'object') return '<redacted>';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v));
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJson(v, k);
    return out;
  }
  return value;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_KEY.test(k) || /^set-cookie$/i.test(k) ? '<redacted>' : redactText(v);
  return out;
}
