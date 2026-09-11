// Управление мастерами. Список (GET) может прочитать любой вошедший — он
// нужен, например, чтобы выбрать, на кого назначить обращение. Изменения
// (добавить/поменять/удалить) — только для администратора. Пароли наружу
// никогда не отдаём, только логин/имя/роль/активность.

import { redis, readBody, requireUser, requireAdmin, hashPassword } from "./_lib.js";

const KEY = "vella:users";
const loadUsers = async (r) => (await r.get(KEY)) || { users: [] };
const publicUser = (u) => ({ id: u.id, login: u.login, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt });
const activeAdmins = (users) => users.filter((x) => x.role === "admin" && x.active);

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!requireUser(req, res)) return;
    const { users } = await loadUsers(r);
    return res.status(200).json({ users: users.map(publicUser) });
  }

  if (req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const login = String(body.login || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const role = body.role === "admin" ? "admin" : "master";
    if (!login || !name || password.length < 4)
      return res.status(400).json({ error: "заполните имя, логин и пароль (от 4 символов)" });
    const store = await loadUsers(r);
    if (store.users.some((u) => u.login === login))
      return res.status(409).json({ error: "такой логин уже есть" });
    const user = {
      id: `${login}-${Date.now().toString(36)}`, login, name, role, active: true,
      pwd: hashPassword(password), createdAt: new Date().toISOString(),
    };
    store.users.push(user);
    await r.set(KEY, store);
    return res.status(200).json({ user: publicUser(user) });
  }

  if (req.method === "PUT") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const store = await loadUsers(r);
    const u = store.users.find((x) => x.id === body.id);
    if (!u) return res.status(404).json({ error: "не найден" });

    if (body.name) u.name = String(body.name).trim();

    if (body.role === "admin" || body.role === "master") {
      if (u.role === "admin" && body.role === "master" && activeAdmins(store.users).length <= 1)
        return res.status(400).json({ error: "нельзя убрать последнего администратора" });
      u.role = body.role;
    }
    if (typeof body.active === "boolean") {
      if (u.role === "admin" && !body.active && activeAdmins(store.users).length <= 1)
        return res.status(400).json({ error: "нельзя отключить последнего администратора" });
      u.active = body.active;
    }
    if (body.password) {
      if (String(body.password).length < 4) return res.status(400).json({ error: "пароль слишком короткий" });
      u.pwd = hashPassword(body.password);
    }
    await r.set(KEY, store);
    return res.status(200).json({ user: publicUser(u) });
  }

  if (req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const store = await loadUsers(r);
    const u = store.users.find((x) => x.id === body.id);
    if (!u) return res.status(404).json({ error: "не найден" });
    if (u.role === "admin" && activeAdmins(store.users).length <= 1)
      return res.status(400).json({ error: "нельзя удалить последнего администратора" });
    store.users = store.users.filter((x) => x.id !== body.id);
    await r.set(KEY, store);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
