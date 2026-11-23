// Client for /api/*. Identity is an anonymous random UUID kept in localStorage and
// sent as X-Device-Token; the server stores only its hash.

const TOKEN_KEY = 'wawg:token';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deviceToken() {
  let t = null;
  try { t = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  if (!t || !UUID_RE.test(t)) {
    t = crypto.randomUUID();
    try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  }
  return t;
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'x-device-token': deviceToken(), ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new ApiError("Couldn't reach the game. Check your connection and try again.", 0);
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong. Try again in a moment.', res.status);
  return data;
}

const q = (d) => `?date=${encodeURIComponent(d)}`;
export const api = {
  today: (date) => call('GET', '/today' + q(date)),
  guess: (date, destId) => call('POST', '/today/guess', { date, destId }),
  state: (date) => call('GET', '/state' + q(date)),
  createCouple: () => call('POST', '/couples'),
  joinCouple: (code) => call('POST', `/couples/${encodeURIComponent(code)}/join`),
  leaveCouple: () => call('POST', '/couples/leave'),
};
