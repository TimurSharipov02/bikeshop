import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, phoneLogin, hashPassword } from '../api/_lib.js';
import authHandler from '../api/auth.js';
import usersHandler from '../api/users.js';

const oldSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'test-only-secret';
const res = () => ({ statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } });
const memory = (users) => {
  let data = { users };
  return { get: async () => structuredClone(data), set: async (_k, v) => { data = structuredClone(v); }, read: () => data };
};
const adminCookie = { cookie: `vella_session=${signSession({ uid: 'a', role: 'admin', authVersion: 0 })}` };

test('any way of writing a Russian number becomes one login', () => {
  for (const s of ['+79966061200', '+7 (996) 606-12-00', '89966061200', '9966061200']) assert.equal(phoneLogin(s), '+79966061200');
  assert.equal(phoneLogin('timur'), '');
  assert.equal(phoneLogin('+7 996 606'), '');
});

test('an admin changes a login to a phone; the master then signs in with it written any way', async () => {
  const r = memory([
    { id: 'a', login: 'timur', name: 'Тимур', role: 'admin', active: true, pwd: hashPassword('1234') },
    { id: 'm', login: 'sergey', name: 'Сергей', role: 'master', active: true, pwd: hashPassword('5678') },
  ]);
  const put = res();
  await usersHandler({ method: 'PUT', headers: adminCookie, body: { id: 'm', login: '+7 (999) 162-84-13' } }, put, r);
  assert.equal(put.statusCode, 200);
  assert.equal(r.read().users[1].login, '+79991628413');
  assert.equal(r.read().users[1].id, 'm', 'id stays — reports and orders keep pointing at the master');

  const clash = res();
  await usersHandler({ method: 'PUT', headers: adminCookie, body: { id: 'a', login: '89991628413' } }, clash, r);
  assert.equal(clash.statusCode, 409);
  const bad = res();
  await usersHandler({ method: 'PUT', headers: adminCookie, body: { id: 'a', login: '+7 999' } }, bad, r);
  assert.equal(bad.statusCode, 400);

  const login = res();
  await authHandler({ method: 'POST', headers: {}, body: { action: 'login', login: '8 999 162 84 13', password: '5678' } }, login, r);
  assert.equal(login.statusCode, 200);
  assert.equal(login.body.user.id, 'm');
  const old = res();
  await authHandler({ method: 'POST', headers: {}, body: { action: 'login', login: 'sergey', password: '5678' } }, old, r);
  assert.equal(old.statusCode, 401, 'the old text login no longer works once replaced');
  const notYet = res();
  await authHandler({ method: 'POST', headers: {}, body: { action: 'login', login: 'Timur', password: '1234' } }, notYet, r);
  assert.equal(notYet.statusCode, 200, 'a master without a phone yet still signs in with the old login');
});

after(() => {
  if (oldSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = oldSecret;
});
