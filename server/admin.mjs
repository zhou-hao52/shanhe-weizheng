// 账号服务只读管理接口：/api/account/admin/*
//
// 与用户接口完全隔离：独立口令、独立令牌、独立的无状态签名，
// 不查 sessions 表、不复用用户 Bearer 令牌、不返回密码哈希与内部用户 ID。
// 唯一的写操作是「使某账号的现有会话失效」。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, verifyPassword } from './security.mjs';
import { queryOne } from './store.mjs';

const prefix = '/api/account/admin';
const tokenHours = 12;
const tokenTtl = tokenHours * 3600 * 1000;

const passwordHash = process.env.ADMIN_PASSWORD_HASH || '';
const tokenSecret = process.env.ADMIN_TOKEN_SECRET || '';
// 口令哈希必须与 security.mjs 的 hashPassword 输出同构，否则每次校验都会失败
const hashLooksValid = /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{16,}\$[0-9a-f]{32,}$/.test(passwordHash);
const configured = hashLooksValid && tokenSecret.length >= 32;

const SORTS = {
  created: 'u.created_at',
  updated: 'p.updated_at',
  visited: 'visited',
  favorites: 'favorites',
  quiz: 'quiz',
  username: 'u.username'
};
const SIZES = new Set([15, 30, 50]);
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;

function sign(exp) {
  return createHmac('sha256', tokenSecret).update(String(exp)).digest('base64url');
}

function issueToken() {
  const exp = Date.now() + tokenTtl;
  return { token: `${exp}.${sign(exp)}`, expiresAt: exp };
}

function verifyToken(value) {
  const [exp, sig] = String(value || '').split('.');
  if (!/^\d{10,16}$/.test(exp || '') || !/^[A-Za-z0-9_-]{43}$/.test(sig || '')) return false;
  const expected = sign(exp);
  if (expected.length !== sig.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return false;
  const expAt = Number(exp);
  return expAt > Date.now() && expAt - Date.now() <= tokenTtl;
}

async function queryAll(database, statement, parameters = []) {
  const [rows] = await database.execute(statement, parameters);
  return rows;
}

async function scalar(database, statement, parameters = []) {
  const row = await queryOne(database, statement, parameters);
  return Number(row?.n ?? 0);
}

function cleanTerm(value) {
  return typeof value === 'string' ? value.trim().slice(0, 24) : '';
}

function clampInt(value, fallback, minimum, maximum) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(Math.max(n, minimum), maximum);
}

function readUsername(value) {
  const username = typeof value === 'string' ? value.trim() : '';
  if (!USERNAME.test(username)) throw new HttpError(400, '账号名不合法。');
  return username;
}

function decodeIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function overview(database) {
  const now = Date.now();
  const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const total = await scalar(database, 'SELECT COUNT(*) AS n FROM users');
  const recent = await scalar(database, 'SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', [since]);
  const active = await scalar(
    database,
    `SELECT COUNT(*) AS n FROM progress
      WHERE JSON_LENGTH(visited_json) + JSON_LENGTH(quiz_json) + JSON_LENGTH(favorites_json) > 0`
  );
  const stations = await scalar(database, 'SELECT COUNT(*) AS n FROM progress WHERE JSON_LENGTH(visited_json) >= 15');
  const quiz = await scalar(database, 'SELECT COUNT(*) AS n FROM progress WHERE JSON_LENGTH(quiz_json) >= 15');
  const seals = await scalar(
    database,
    'SELECT COUNT(*) AS n FROM progress WHERE JSON_LENGTH(visited_json) >= 15 AND JSON_LENGTH(quiz_json) >= 15'
  );
  const online = await scalar(database, 'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', [now]);
  const latest = await queryOne(database, 'SELECT MAX(updated_at) AS latest FROM progress');
  return {
    users: { total, recent, windowDays: 7 },
    progress: { active, stations, quiz, seals },
    sessions: { online },
    latestSync: latest?.latest ?? null,
    checkedAt: new Date().toISOString()
  };
}

async function listAccounts(database, body) {
  const term = cleanTerm(body.q);
  const hasProgress = body.hasProgress === true;
  const session = body.session === 'online' ? 'online' : body.session === 'offline' ? 'offline' : '';
  const sortKey = SORTS[body.sort] ? body.sort : 'created';
  const order = String(body.order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const size = SIZES.has(Number(body.size)) ? Number(body.size) : 15;
  const page = clampInt(body.page, 1, 1, 10000);
  const now = Date.now();

  const where = [];
  const params = [];
  if (term) {
    where.push('(LOCATE(?, u.username) > 0 OR LOCATE(?, u.nickname) > 0)');
    params.push(term, term);
  }
  if (hasProgress) {
    where.push(
      '(COALESCE(JSON_LENGTH(p.visited_json), 0) + COALESCE(JSON_LENGTH(p.quiz_json), 0) + COALESCE(JSON_LENGTH(p.favorites_json), 0)) > 0'
    );
  }
  if (session === 'online') {
    where.push('EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?)');
    params.push(now);
  }
  if (session === 'offline') {
    where.push('NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?)');
    params.push(now);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await queryOne(
    database,
    `SELECT COUNT(*) AS n FROM users u LEFT JOIN progress p ON p.user_id = u.id ${clause}`,
    params
  );
  const total = Number(totalRow?.n ?? 0);

  const offset = (page - 1) * size;
  const rows = await queryAll(
    database,
    `SELECT u.username, u.nickname, u.created_at, p.updated_at, p.last_node,
       COALESCE(JSON_LENGTH(p.visited_json), 0) AS visited,
       COALESCE(JSON_LENGTH(p.favorites_json), 0) AS favorites,
       COALESCE(JSON_LENGTH(p.quiz_json), 0) AS quiz,
       EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS online
     FROM users u LEFT JOIN progress p ON p.user_id = u.id
     ${clause}
     ORDER BY ${SORTS[sortKey]} ${order}, u.username ASC
     LIMIT ${size} OFFSET ${offset}`,
    [now, ...params]
  );

  return {
    list: rows.map(row => ({
      username: row.username,
      nickname: row.nickname || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at || null,
      visited: Number(row.visited ?? 0),
      favorites: Number(row.favorites ?? 0),
      quiz: Number(row.quiz ?? 0),
      lastNode: row.last_node || null,
      online: Number(row.online ?? 0) === 1
    })),
    total,
    page,
    size,
    sort: sortKey,
    order: order.toLowerCase(),
    term
  };
}

async function accountDetail(database, body) {
  const username = readUsername(body.username);
  const row = await queryOne(
    database,
    `SELECT u.username, u.nickname, u.created_at, p.visited_json, p.favorites_json, p.quiz_json, p.last_node, p.updated_at
     FROM users u LEFT JOIN progress p ON p.user_id = u.id
     WHERE u.username = ? LIMIT 1`,
    [username]
  );
  if (!row) throw new HttpError(404, '账号不存在或已被删除。');
  const session = await queryOne(
    database,
    `SELECT COUNT(*) AS n, MAX(expires_at) AS latest FROM sessions
     WHERE user_id = (SELECT id FROM users WHERE username = ?) AND expires_at > ?`,
    [username, Date.now()]
  );
  return {
    user: { username: row.username, nickname: row.nickname || '', createdAt: row.created_at },
    progress: {
      visited: decodeIds(row.visited_json),
      favorites: decodeIds(row.favorites_json),
      quiz: decodeIds(row.quiz_json),
      lastNode: row.last_node || null,
      updatedAt: row.updated_at || null
    },
    session: {
      online: Number(session?.n ?? 0) > 0,
      expiresAt: session?.latest ? Number(session.latest) : null
    }
  };
}

async function revokeSessions(database, body) {
  const username = readUsername(body.username);
  const row = await queryOne(database, 'SELECT id FROM users WHERE username = ?', [username]);
  if (!row) throw new HttpError(404, '账号不存在或已被删除。');
  const [result] = await database.execute('DELETE FROM sessions WHERE user_id = ?', [row.id]);
  return { revoked: Number(result?.affectedRows ?? 0), checkedAt: new Date().toISOString() };
}

/**
 * 管理接口分派。由 app.mjs 在方法/来源校验之后调用，绝不经过用户会话校验。
 * @param {object} database mysql2 连接池
 * @param {object} request node:http 请求
 * @param {string} pathname 已解析的路径
 * @param {{ limit: Function, remote: string, readJson: Function }} context
 */
export async function adminApi(database, request, pathname, { limit, remote, readJson }) {
  if (!configured) {
    throw new HttpError(503, '账号服务尚未启用管理接口，请先在部署环境配置管理口令。', { retryAfter: 60 });
  }
  const started = Date.now();
  try {
    if (request.method !== 'POST') throw new HttpError(405, '管理接口仅支持 POST。');

    if (pathname === `${prefix}/login`) {
      limit(`admin-login:${remote}`, 5, 15 * 60 * 1000);
      const body = await readJson(request);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password || password.length > 128) throw new HttpError(400, '请输入管理口令。');
      let ok = false;
      try {
        ok = await verifyPassword(password, passwordHash);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        ok = false;
      }
      if (!ok) throw new HttpError(401, '管理口令不正确。');
      const issued = issueToken();
      return { ...issued, scope: 'accounts-read', expiresIn: tokenHours * 3600 };
    }

    const body = await readJson(request);
    if (!verifyToken(body.token)) throw new HttpError(401, '管理会话已过期，请重新输入口令。');
    limit(`admin:${remote}`, 240, 60 * 1000);

    if (pathname === `${prefix}/overview`) return overview(database);
    if (pathname === `${prefix}/accounts`) return listAccounts(database, body);
    if (pathname === `${prefix}/account`) return accountDetail(database, body);
    if (pathname === `${prefix}/sessions/revoke`) return revokeSessions(database, body);
    throw new HttpError(404, '管理接口不存在。');
  } finally {
    // 只记路径与耗时：口令、令牌、搜索词都不进日志
    console.log(`[admin] ${request.method} ${pathname} ${Date.now() - started}ms`);
  }
}
