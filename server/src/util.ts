export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DEVICE_TOKEN: string;
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
}

export const nowIso = () => new Date().toISOString();
export const uid = (n = 10) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
};

export async function kvGet<T>(env: Env, key: string): Promise<{ value: T; updatedAt: string } | null> {
  const r = await env.DB.prepare('SELECT json, updated_at FROM kv WHERE key = ?').bind(key).first<{ json: string; updated_at: string }>();
  return r ? { value: JSON.parse(r.json) as T, updatedAt: r.updated_at } : null;
}

export async function kvSet(env: Env, key: string, value: unknown) {
  await env.DB.prepare('INSERT INTO kv (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), nowIso()).run();
}

export async function kvDel(env: Env, key: string) {
  await env.DB.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();
}

export async function sha1(s: string) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

export function timingSafeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function fetchJson<T = any>(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'InkBoard/1.0 (+personal e-ink dashboard)', Accept: 'application/json', ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} ${url.split('?')[0]}`);
  return r.json() as Promise<T>;
}

/** Secrets the user pastes in the Mac editor (API keys etc.). Stored in D1, never sent to the device. */
export async function getSecrets(env: Env): Promise<Record<string, string>> {
  return (await kvGet<Record<string, string>>(env, 'secrets'))?.value || {};
}
