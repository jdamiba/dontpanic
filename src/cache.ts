// A small cache that (1) persists to disk so restarts don't re-pay for agent calls,
// (2) dedupes in-flight computations so concurrent identical calls share one run,
// and (3) honors a per-entry TTL. Failures are NOT cached (fn throws → nothing stored).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DIR } from "./config.js";

const CACHE_DIR = join(DIR, "cache");

interface Rec<T> {
  at: number;
  ttl: number;
  value: T;
}

const mem = new Map<string, Rec<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const slug = (key: string) => createHash("sha1").update(key).digest("hex").slice(0, 40);
const pathFor = (ns: string, key: string) => join(CACHE_DIR, ns, slug(key) + ".json");

export async function cached<T>(ns: string, key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const full = `${ns}:${key}`;
  const now = Date.now();

  const m = mem.get(full);
  if (m && now - m.at < m.ttl) return m.value as T;

  const p = pathFor(ns, key);
  if (existsSync(p)) {
    try {
      const rec = JSON.parse(readFileSync(p, "utf8")) as Rec<T>;
      if (now - rec.at < rec.ttl) {
        mem.set(full, rec);
        return rec.value;
      }
    } catch { /* corrupt entry — recompute */ }
  }

  const existing = inflight.get(full);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    const value = await fn();
    const rec: Rec<T> = { at: Date.now(), ttl: ttlMs, value };
    mem.set(full, rec);
    try {
      mkdirSync(join(CACHE_DIR, ns), { recursive: true });
      writeFileSync(p, JSON.stringify(rec));
    } catch { /* disk best-effort */ }
    return value;
  })().finally(() => inflight.delete(full));

  inflight.set(full, promise);
  return promise;
}

/** Read a cached value without computing it — returns null on miss/expiry. */
export function peek<T>(ns: string, key: string): T | null {
  const full = `${ns}:${key}`;
  const now = Date.now();
  const m = mem.get(full);
  if (m && now - m.at < m.ttl) return m.value as T;
  const p = pathFor(ns, key);
  if (existsSync(p)) {
    try {
      const rec = JSON.parse(readFileSync(p, "utf8")) as Rec<T>;
      if (now - rec.at < rec.ttl) { mem.set(full, rec); return rec.value; }
    } catch { /* corrupt entry */ }
  }
  return null;
}

/** Test/maintenance helper: drop all in-memory entries. */
export function _clearMemory(): void {
  mem.clear();
  inflight.clear();
}
