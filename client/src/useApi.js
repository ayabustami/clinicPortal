/**
 * useApi — the app's read hook: cached, de-duplicated, stale-while-revalidate.
 *
 * Contract (deliberate, so failures are never hidden):
 *  - `data`      last known good payload (cache or network).
 *  - `isLoading` true only while there is NO data to show (first load) — pages
 *                render skeletons for this, never an indefinite spinner.
 *  - `isRefreshing` a background revalidation is running while `data` is shown.
 *  - `error`     the most recent failure. If it happens with no cached data the
 *                page shows an error state + Retry; with cached data the page
 *                keeps showing it and surfaces a subtle stale/error notice.
 *  - Late responses can never overwrite newer ones (sequence guard per hook).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cachedGet, invalidate, read, subscribe, DEFAULT_TTL } from './apiCache.js';

export function useApi(path, { ttl = DEFAULT_TTL, skip = false } = {}) {
  const cached = path && !skip ? read(path) : undefined;
  const [state, setState] = useState({
    data: cached ? cached.data : null,
    error: '',
    isLoading: !!(path && !skip && !cached),
    isRefreshing: false,
  });
  const seqRef = useRef(0);

  // Re-render when the cache entry for this path changes (mutation invalidation,
  // another component's fetch landing, etc.)
  useEffect(() => subscribe(() => {
    if (!path || skip) return;
    const hit = read(path);
    if (hit) setState((s) => (s.data === hit.data ? s : { ...s, data: hit.data, isLoading: false }));
  }), [path, skip]);

  useEffect(() => {
    if (!path || skip) return undefined;
    const seq = ++seqRef.current;
    let live = true;
    const hit = read(path);
    if (hit && Date.now() - hit.at <= ttl) {
      setState({ data: hit.data, error: '', isLoading: false, isRefreshing: false });
      return undefined; // fresh cache: zero network
    }
    setState((s) => ({
      ...s,
      data: hit ? hit.data : s.data,
      isLoading: hit || s.data ? false : true,
      isRefreshing: !!(hit || s.data),
    }));
    cachedGet(path, { ttl })
      .then((res) => { if (live && seq === seqRef.current) setState({ data: res.data, error: '', isLoading: false, isRefreshing: false }); })
      .catch((err) => {
        if (!live || seq !== seqRef.current) return;
        setState((s) => ({ data: s.data, error: err.message, isLoading: false, isRefreshing: false }));
      });
    return () => { live = false; };
  }, [path, ttl, skip]);

  /** Force a network read (used after mutations and by Retry buttons). */
  const refetch = useCallback(() => {
    if (!path) return Promise.resolve(null);
    const seq = ++seqRef.current;
    setState((s) => ({ ...s, isRefreshing: !!s.data, isLoading: !s.data }));
    return cachedGet(path, { force: true })
      .then((res) => { if (seq === seqRef.current) setState({ data: res.data, error: '', isLoading: false, isRefreshing: false }); return res.data; })
      .catch((err) => { if (seq === seqRef.current) setState((s) => ({ ...s, error: err.message, isLoading: false, isRefreshing: false })); throw err; });
  }, [path]);

  return { ...state, refetch, invalidate };
}
