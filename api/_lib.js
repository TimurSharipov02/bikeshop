// Общие вспомогательные функции для серверных функций: подключение к Redis,
// хеширование паролей и подписанные сессионные куки. Обычный Node, без
// сторонних библиотек для авторизации.

import { Redis } from "@upstash/redis";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

export function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function readBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
}

// ---------------------------- пароли --------------------------------------

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex"), b = Buffer.from(check, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------- сессия (подписанная кука) --------------------
// Без хранения сессий на сервере: кука несёт данные + подпись HMAC секретом
// из переменной окружения SESSION_SECRET (задаётся в Vercel → Environment
// Variables). Так проще, чем городить отдельное хранилище сессий в Redis.

const COOKIE_NAME = "vella_session";
const MAX_AGE_SEC = 30 * 24 * 3600; // 30 дней

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET не задан в переменных окружения");
  return s;
}

export function signSession(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + MAX_AGE_SEC * 1000 })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function parseCookies(req) {
  const raw = req.headers?.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getSession(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}
export function setSessionCookie(res, payload) {
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${signSession(payload)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SEC}`);
}
export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// ---------------------------- доступ ----------------------------------------

export function requireUser(req, res) {
  const s = getSession(req);
  if (!s) { res.status(401).json({ error: "нужно войти" }); return null; }
  return s;
}
export function requireAdmin(req, res) {
  const s = requireUser(req, res);
  if (!s) return null;
  if (s.role !== "admin") { res.status(403).json({ error: "только для администратора" }); return null; }
  return s;
}
