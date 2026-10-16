/**
 * Request-level cache + in-flight de-duplication.
 *
 * Two problems this solves, both measured (see PERF-LOADING-REPORT.md):
 *  1. Concurrent identical GETs (React StrictMode double-mount, a tab and its
 *     parent both asking for clinic meta, a re-render while a fetch is live)
 *     hit the network twice. One promise is now shared by all callers.
 *  2. Navigating back to a page refetched everything from scratch and blanked
 *     the screen while doing it. Valid cached responses render immediately and
 *     revalidate in the background.
 *
 * Writes (POST/PUT/DELETE) never go through here: they call `api()` directly and
 * then invalidate the affected keys, so a mutation is always followed by fresh
 * reads rather than a served-from-cache stale view.
 */
import { api } from './api.js';

/** Default freshness window. Short enough that clinical/financial data cannot
 *  drift meaningfully, long enough to absorb tab switches and back-navigation. */
export const DEFAULT_TTL = 15000;

const cache = new Map();     // key -> { data, at }
const inflight = new Map();  // key -> Promise
const listeners = new Set(); // () => void

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a broken subscriber must not break the cache */ }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Cache snapshot for a key (used by the hook via useSyncExternalStore). */
export function read(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  return { data: hit.data, at: hit.at, age: Date.now() - hit.at };
}

export function isFresh(key, ttl = DEFAULT_TTL) {
  const hit = cache.get(key);
  return !!hit && Date.now() - hit.at <= ttl;
}

/**
 * GET with de-duplication + cache. Returns { data, fromCache, age }.
 * Never throws away the old value on a background revalidation failure: the
 * caller gets { data: <stale>, error } and decides how to surface it.
 */
export async function cachedGet(path, { ttl = DEFAULT_TTL, force = false, signal } = {}) {
  const hit = cache.get(path);
  if (!force && hit && Date.now() - hit.at <= ttl) {
    return { data: hit.data, fromCache: true, age: Date.now() - hit.at };
  }
  if (inflight.has(path)) {
    // Join the request already in flight — this is what collapses React
    // StrictMode's double-effect (and double-mounted components) into a
    // single network call without disabling StrictMode.
    const data = await inflight.get(path);
    return { data, fromCache: false, age: 0, deduped: true };
  }

  const promise = api(path, { signal });
  inflight.set(path, promise);
  try {
    const data = await promise;
    cache.set(path, { data, at: Date.now() });
    notify();
    return { data, fromCache: false, age: 0 };
  } finally {
    inflight.delete(path);
  }
}

/** Drop cached entries. `matcher` is a prefix string or a predicate on the key. */
export function invalidate(matcher) {
  if (!matcher) { cache.clear(); notify(); return; }
  const test = typeof matcher === 'function' ? matcher : (k) => k.startsWith(matcher);
  let changed = false;
  for (const key of cache.keys()) {
    if (test(key)) { cache.delete(key); changed = true; }
  }
  if (changed) notify();
}

/** Write a value into the cache without a request (e.g. optimistic update). */
export function prime(path, data) {
  cache.set(path, { data, at: Date.now() });
  notify();
}

/** Prefetch in the background; never throws (failures are reported by the real read). */
export function warm(path, opts) {
  cachedGet(path, opts).catch(() => {});
}

/** Clinical/financial mutations change what the patient timeline shows.
 *  Call after any record/plan/session/invoice/payment mutation so an open
 *  (keep-alive) timeline tab revalidates instead of serving stale events. */
export function invalidateTimelines() {
  invalidate((k) => k.includes('/timeline'));
}
