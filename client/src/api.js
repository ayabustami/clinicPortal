
/** Minimal fetch wrapper for the Clinic Portal API. */
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    signal,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }

  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.fields = data?.error?.fields || null;
    err.code = data?.error?.code || null;

    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(
        new CustomEvent('cmp:unauthorized', { detail: { path } })
      );
    }

    throw err;
  }

  return data;
}
