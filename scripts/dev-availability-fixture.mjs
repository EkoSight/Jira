/**
 * A fortnight of leave in the LOCAL DEV database, through the ordinary API, so
 * the dashboard card, the team calendar and the assignment warning have
 * something real to show.
 *
 * Development aid only. Never run this against production.
 */
const API = 'http://localhost:4000/api/taskflow';
let token = null;

const call = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
};

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const plus = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

token = (await call('POST', '/auth/login', { email: 'admin@ekosight.com', password: 'ChangeMe123!' })).token;
const { users } = await call('GET', '/users');
const others = users.filter((u) => u.email !== 'admin@ekosight.com');
const [first, second, third] = others;
const me = users.find((u) => u.email === 'admin@ekosight.com');

// clear earlier runs so the fixture does not pile up
const { entries } = await call('GET', `/availability?from=${plus(-30)}&to=${plus(60)}`);
for (const e of entries) await call('DELETE', `/availability/${e.id}`);

const book = (body) => call('POST', '/availability', body).catch((err) => console.warn(err.message));

if (first) {
  await book({ user_id: first.id, status: 'ON_LEAVE', start_date: plus(3), end_date: plus(7),
    note: 'Family wedding in Jaipur — back after, reachable on WhatsApp for urgent things' });
}
if (second) {
  await book({ user_id: second.id, status: 'HALF_DAY', start_date: today, day_part: 'AFTERNOON',
    note: 'Out from 1pm' });
  await book({ user_id: second.id, status: 'UNAVAILABLE', start_date: plus(10), end_date: plus(11),
    note: 'Field visits in Nashik, patchy signal' });
}
if (third) {
  await book({ user_id: third.id, status: 'ON_LEAVE', start_date: today, end_date: plus(1) });
}
await book({ user_id: me.id, status: 'ON_LEAVE', start_date: plus(14), end_date: plus(16), note: 'Diwali' });

console.log(`done — ${first?.full_name} on leave ${plus(3)}–${plus(7)}`);
