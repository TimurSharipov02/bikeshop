import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession, requireUser, requireAdmin } from '../api/_lib.js';
import authHandler from '../api/auth.js';

const oldSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'test-only-secret';
const req = (payload) => ({ headers: { cookie: `vella_session=${signSession(payload)}` } });
const res = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } });
const store = (user) => ({ get: async () => ({ users: [user] }) });

test('a disabled account loses access immediately', async () => {
  const response = res();
  assert.equal(await requireUser(req({ uid: 'u', role: 'admin' }), response, store({ id: 'u', role: 'admin', active: false })), null);
  assert.equal(response.statusCode, 401);
});

test('an old admin cookie loses admin rights after a role change', async () => {
  const response = res();
  assert.equal(await requireAdmin(req({ uid: 'u', role: 'admin' }), response, store({ id: 'u', role: 'master', active: true })), null);
  assert.equal(response.statusCode, 403);
});

test('a password reset invalidates an earlier session', async () => {
  const response = res();
  assert.equal(await requireUser(req({ uid: 'u', role: 'master', authVersion: 0 }), response,
    store({ id: 'u', role: 'master', active: true, authVersion: 1 })), null);
  assert.equal(response.statusCode, 401);
});

test('setLook saves the look on the account and GET returns it; unknown styles are rejected', async () => {
  let data = { users: [{ id: 'u', login: 'm', name: 'M', role: 'master', active: true, authVersion: 0 }] };
  const r = { get: async () => structuredClone(data), set: async (_k, v) => { data = structuredClone(v); } };
  const post = (body) => ({ ...req({ uid: 'u', role: 'master', authVersion: 0 }), method: 'POST', body });

  const ok = res();
  await authHandler(post({ action: 'setLook', style: 'paper', theme: 'dark' }), ok, r);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(data.users[0].look, { style: 'paper', theme: 'dark' });

  const me = res();
  await authHandler({ ...req({ uid: 'u', role: 'master', authVersion: 0 }), method: 'GET' }, me, r);
  assert.deepEqual(me.body.user.look, { style: 'paper', theme: 'dark' });

  const bad = res();
  await authHandler(post({ action: 'setLook', style: 'neon', theme: 'dark' }), bad, r);
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(data.users[0].look, { style: 'paper', theme: 'dark' }, 'a rejected look does not overwrite the saved one');
});

after(() => {
  if (oldSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = oldSecret;
});
