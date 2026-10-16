/** Minimal fetch wrapper for the Clinic Portal API. */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    signal,
    credentials: 'same-origin',
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
    // Session expired / revoked anywhere in the app -> notify the auth layer,
    // which signs the user out and routes to /login (keeping the intended path).
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('cmp:unauthorized', { detail: { path } }));
    }
    throw err;
  }
  return data;
}
