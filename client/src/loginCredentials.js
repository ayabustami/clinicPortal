/**
 * Resolve the credentials to submit from the login form.
 *
 * Some browsers (notably iOS Safari password autofill) fill the <input> DOM
 * values WITHOUT dispatching the input/change events React relies on. The
 * controlled React state then stays empty while the visible fields are full,
 * and the request went out with `email: ""` -> HTTP 400 "email is required".
 * The live form values are therefore the source of truth; React state is only
 * a fallback. Blank values are reported as `missing` so the client never sends
 * an empty login request.
 *
 * @param {{ formData?: FormData|null, email?: string, password?: string }} input
 * @returns {{ email: string, password: string, missing: Array<'email'|'password'> }}
 */
export function resolveCredentials({ formData = null, email = '', password = '' } = {}) {
  const domEmail = readField(formData, 'email');
  const domPassword = readField(formData, 'password');

  const emailValue = (domEmail || email || '').trim();
  const passwordValue = domPassword || password || '';

  const missing = [];
  if (!emailValue) missing.push('email');
  // The server trims passwords before checking, so whitespace-only counts as missing.
  if (!passwordValue.trim()) missing.push('password');

  return { email: emailValue, password: passwordValue, missing };
}

function readField(formData, name) {
  if (!formData || typeof formData.get !== 'function') return '';
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}
