import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { cachedGet, invalidate } from './apiCache.js';
import { setCurrency } from './format.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, meta: null });

  const loadMeta = useCallback(async () => {
    // force = always revalidate; the cache layer still de-duplicates the
    // StrictMode double-invocation into ONE network request.
    invalidate('/meta/bootstrap');
    const { data: meta } = await cachedGet('/meta/bootstrap', { force: true });
    setCurrency(meta?.clinic?.currency || 'ILS');
    setState((s) => ({ ...s, meta, user: meta.user }));
    return meta;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        // /meta/bootstrap is authenticated and already returns the user —
        // the old /auth/me call was a redundant sequential round trip that
        // delayed every cold load by one full request.
        await loadMeta();
      } catch {
        setState({ loading: false, user: null, meta: null });
      }
      setState((s) => ({ ...s, loading: false }));
    })();
  }, [loadMeta]);

  // Any API call returning 401 (expired/revoked session) signs the user out.
  // <Protected> then redirects to /login?next=<current path>.
  useEffect(() => {
    const onUnauthorized = () => {
      setState((s) => (s.user ? { loading: false, user: null, meta: null } : s));
    };
    window.addEventListener('cmp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cmp:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api('/auth/login', { method: 'POST', body: { email, password } });
    await loadMeta();
    return res.user;
  }, [loadMeta]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    setState({ loading: false, user: null, meta: null });
  }, []);

  return (
    <AuthCtx.Provider value={{ ...state, login, logout, refreshMeta: loadMeta }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

/** Convenience selectors */
export function useClinicMeta() {
  const { meta, refreshMeta } = useAuth();
  return {
    clinic: meta?.clinic || null,
    doctors: (meta?.doctors || []).filter((d) => d.is_active),
    allDoctors: meta?.doctors || [],
    services: meta?.services || [],
    branches: (meta?.branches || []).filter((b) => b.is_active !== false && b.is_active !== 0),
    allBranches: meta?.branches || [],
    doctorProfile: meta?.doctor_profile || null,
    currency: meta?.clinic?.currency || 'ILS',
    refreshMeta,
  };
}
