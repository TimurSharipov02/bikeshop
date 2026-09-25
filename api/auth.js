// Вход, выход, первый запуск (создание администратора) и смена своего пароля.
// Учётные записи хранятся тем же способом, что и остальные данные — одним
// документом в Upstash Redis.

import { redis, readBody, hashPassword, verifyPassword, getSession, setSessionCookie, clearSessionCookie } from "./_lib.js";

const KEY = "vella:users";
const loadUsers = async (r) => (await r.get(KEY)) || { users: [] };
const publicUser = (u) => ({ id: u.id, login: u.login, name: u.name, role: u.role, commissionPercent: u.commissionPercent || 0, look: u.look || null });
// Оформление (Профиль → Оформление) — за учётной записью, а не за телефоном:
// мастер видит свой вид на любом устройстве. Список — как STYLE_PRESETS в web/app.js.
const LOOK_STYLES = ["aero", "calm", "soft", "workshop", "graphite", "paper", "terminal"];
const LOOK_THEMES = ["auto", "light", "dark"];

// r — хранилище; параметром для тестов (tests/auth.test.js), как в других ручках.
export default async function handler(req, res, r = redis()) {
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    const s = getSession(req);
    const store = await loadUsers(r);
    if (s) {
      const u = store.users.find((x) => x.id === s.uid && x.active);
      if (u) return res.status(200).json({ authenticated: true, user: publicUser(u) });
    }
    return res.status(200).json({ authenticated: false, needsSetup: store.users.length === 0 });
  }

  if (req.method === "POST") {
    const body = readBody(req);
    const store = await loadUsers(r);

    if (body.action === "bootstrap") {
      if (store.users.length > 0) return res.status(400).json({ error: "администратор уже создан" });
      const login = String(body.login || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!login || !name || password.length < 4)
        return res.status(400).json({ error: "заполните имя, логин и пароль (от 4 символов)" });
      const user = {
        id: `${login}-${Date.now().toString(36)}`, login, name, role: "admin", active: true,
        pwd: hashPassword(password), createdAt: new Date().toISOString(),
      };
      store.users.push(user);
      await r.set(KEY, store);
      setSessionCookie(res, { uid: user.id, role: user.role, authVersion: 0 });
      return res.status(200).json({ user: publicUser(user) });
    }

    if (body.action === "login") {
      const login = String(body.login || "").trim().toLowerCase();
      const u = store.users.find((x) => x.login === login && x.active);
      if (!u || !verifyPassword(body.password || "", u.pwd))
        return res.status(401).json({ error: "неверный логин или пароль" });
      setSessionCookie(res, { uid: u.id, role: u.role, authVersion: u.authVersion || 0 });
      return res.status(200).json({ user: publicUser(u) });
    }

    if (body.action === "logout") {
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    if (body.action === "changePassword") {
      const s = getSession(req);
      const u = s && store.users.find((x) => x.id === s.uid && x.active);
      if (!u) return res.status(401).json({ error: "нужно войти" });
      if (!verifyPassword(body.currentPassword || "", u.pwd))
        return res.status(401).json({ error: "неверный текущий пароль" });
      if (String(body.newPassword || "").length < 4)
        return res.status(400).json({ error: "новый пароль слишком короткий" });
      u.pwd = hashPassword(body.newPassword);
      u.authVersion = (u.authVersion || 0) + 1;
      await r.set(KEY, store);
      setSessionCookie(res, { uid: u.id, role: u.role, authVersion: u.authVersion });
      return res.status(200).json({ ok: true });
    }

    if (body.action === "setLook") {
      const s = getSession(req);
      const u = s && store.users.find((x) => x.id === s.uid && x.active);
      if (!u) return res.status(401).json({ error: "нужно войти" });
      if (!LOOK_STYLES.includes(body.style) || !LOOK_THEMES.includes(body.theme))
        return res.status(400).json({ error: "неизвестное оформление" });
      u.look = { style: body.style, theme: body.theme };
      await r.set(KEY, store);
      return res.status(200).json({ ok: true, look: u.look });
    }

    return res.status(400).json({ error: "неизвестное действие" });
  }

  return res.status(405).json({ error: "method not allowed" });
}
