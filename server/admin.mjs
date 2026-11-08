// 账号服务管理接口：/api/account/admin/*
//
// 管理口令、管理会话和审计记录与普通用户完全隔离，不复用用户 Bearer 令牌。
// 管理令牌保存在 admin_sessions 中，退出或结束会话后可立即失效。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { digest, HttpError, verifyPassword } from './security.mjs';
import { queryOne, transaction } from './store.mjs';

const prefix = '/api/account/admin';
const tokenHours = 12;
const tokenTtl = tokenHours * 3600 * 1000;

const passwordHash = process.env.ADMIN_PASSWORD_HASH || '';
const tokenSecret = process.env.ADMIN_TOKEN_SECRET || '';
const configuredName = typeof process.env.ADMIN_NAME === 'string' ? process.env.ADMIN_NAME.trim() : '';
const adminName = configuredName && [...configuredName].length <= 32 && !/[\u0000-\u001f\u007f]/.test(configuredName)
  ? configuredName
  : 'admin';
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
const AUDIT_SIZES = new Set([20, 50, 100]);
const USERNAME = /^[A-Za-z0-9_]{3,24}$/;
const TOKEN = /^(\d{13})\.([A-Za-z0-9_-]{20,32})\.([A-Za-z0-9_-]{43})$/;

function cleanText(value, maximum) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum)
    : '';
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

function readReason(value) {
  const reason = cleanText(value, 160);
  if (!reason) throw new HttpError(400, '请输入停用或恢复账号的原因。');
  return reason;
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

function sign(payload) {
  return createHmac('sha256', tokenSecret).update(payload).digest('base64url');
}

function issueToken() {
  const expiresAt = Date.now() + tokenTtl;
  const nonce = randomBytes(18).toString('base64url');
  const payload = `${expiresAt}.${nonce}`;
  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

function parseToken(value) {
  const match = String(value || '').match(TOKEN);
  if (!match) return null;
  const [, expiresAt, nonce, signature] = match;
  const expected = sign(`${expiresAt}.${nonce}`);
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  const expiration = Number(expiresAt);
  if (!Number.isSafeInteger(expiration) || expiration <= Date.now() || expiration - Date.now() > tokenTtl) return null;
  return { token: String(value), expiresAt: expiration };
}

async function queryAll(database, statement, parameters = []) {
  const [rows] = await database.execute(statement, parameters);
  return rows;
}

async function scalar(database, statement, parameters = []) {
  const row = await queryOne(database, statement, parameters);
  return Number(row?.n ?? 0);
}

export async function recordAdminAudit(database, { actor = 'anonymous', action, target = null, result, detail = null }) {
  const safeAction = cleanText(action, 48);
  const safeResult = cleanText(result, 16);
  if (!safeAction || !safeResult) throw new Error('审计事件缺少动作或结果。');
  await database.execute(`
    INSERT INTO admin_audit_events (actor, action, target, result, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [cleanText(actor, 32) || 'anonymous', safeAction, cleanText(target, 64) || null,
    safeResult, cleanText(detail, 255) || null, new Date().toISOString()]);
}

export async function recordAdminAccessDenied(database, pathname, detail) {
  try {
    await recordAdminAudit(database, {
      action: 'access_denied',
      target: pathname,
      result: 'denied',
      detail
    });
  } catch (error) {
    console.error('Admin audit write failed:', error.code || error.name);
  }
}

async function authenticateAdmin(database, token) {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const row = await queryOne(database, 'SELECT actor, expires_at FROM admin_sessions WHERE token_hash = ? LIMIT 1', [digest(parsed.token)]);
  if (!row || Number(row.expires_at) !== parsed.expiresAt || Number(row.expires_at) <= Date.now()) {
    if (row) await database.execute('DELETE FROM admin_sessions WHERE token_hash = ?', [digest(parsed.token)]);
    return null;
  }
  return { actor: row.actor, expiresAt: parsed.expiresAt, token: parsed.token };
}

async function createAdminSession(database) {
  const issued = issueToken();
  const now = new Date().toISOString();
  await transaction(database, async connection => {
    await connection.execute('DELETE FROM admin_sessions WHERE expires_at <= ?', [Date.now()]);
    await connection.execute('INSERT INTO admin_sessions (token_hash, actor, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [digest(issued.token), adminName, now, issued.expiresAt]);
    await recordAdminAudit(connection, { actor: adminName, action: 'admin_login', result: 'success' });
  });
  return issued;
}

async function overview(database) {
  const now = Date.now();
  const since = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const users = await queryOne(database, `
    SELECT COUNT(*) AS total,
      COALESCE(SUM(status = 'active'), 0) AS active,
      COALESCE(SUM(status = 'disabled'), 0) AS disabled
    FROM users
  `);
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
    users: {
      total: Number(users?.total ?? 0),
      recent,
      active: Number(users?.active ?? 0),
      disabled: Number(users?.disabled ?? 0),
      windowDays: 7
    },
    progress: { active, stations, quiz, seals },
    sessions: { online },
    latestSync: latest?.latest ?? null,
    checkedAt: new Date().toISOString()
  };
}

async function listAccounts(database, body) {
  const term = cleanText(body.q, 24);
  const hasProgress = body.hasProgress === true;
  const session = body.session === 'online' ? 'online' : body.session === 'offline' ? 'offline' : '';
  const status = body.status === 'active' || body.status === 'disabled' ? body.status : '';
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
  if (status) {
    where.push('u.status = ?');
    params.push(status);
  }
  if (hasProgress) {
    where.push(
      '(COALESCE(JSON_LENGTH(p.visited_json), 0) + COALESCE(JSON_LENGTH(p.quiz_json), 0) + COALESCE(JSON_LENGTH(p.favorites_json), 0)) > 0'
    );
  }
  if (session === 'online') {
    where.push('EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?)');
    params.push(now);
  } else if (session === 'offline') {
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
    `SELECT u.username, u.nickname, u.created_at, u.status, u.disabled_at, u.disabled_reason,
       p.updated_at, p.last_node,
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
      status: row.status,
      disabledAt: row.disabled_at || null,
      disabledReason: row.disabled_reason || null,
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
    `SELECT u.username, u.nickname, u.created_at, u.status, u.disabled_at, u.disabled_reason,
       p.visited_json, p.favorites_json, p.quiz_json, p.last_node, p.updated_at
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
  const events = await queryAll(
    database,
    `SELECT actor, action, result, detail, created_at
     FROM admin_audit_events WHERE target = ? ORDER BY id DESC LIMIT 10`,
    [username]
  );
  return {
    user: {
      username: row.username,
      nickname: row.nickname || '',
      createdAt: row.created_at,
      status: row.status,
      disabledAt: row.disabled_at || null,
      disabledReason: row.disabled_reason || null
    },
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
    },
    recentAudit: events.map(event => ({
      actor: event.actor,
      action: event.action,
      result: event.result,
      detail: event.detail || null,
      createdAt: event.created_at
    }))
  };
}

async function listAudit(database, body) {
  const size = AUDIT_SIZES.has(Number(body.size)) ? Number(body.size) : 20;
  const page = clampInt(body.page, 1, 1, 10000);
  const action = /^[a-z_]{1,48}$/.test(String(body.action || '')) ? String(body.action) : '';
  const result = ['success', 'failed', 'denied', 'no_change'].includes(body.result) ? body.result : '';
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (result) { where.push('result = ?'); params.push(result); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await scalar(database, `SELECT COUNT(*) AS n FROM admin_audit_events ${clause}`, params);
  const rows = await queryAll(
    database,
    `SELECT actor, action, target, result, detail, created_at
     FROM admin_audit_events ${clause} ORDER BY id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`,
    params
  );
  return {
    list: rows.map(row => ({
      actor: row.actor,
      action: row.action,
      target: row.target || null,
      result: row.result,
      detail: row.detail || null,
      createdAt: row.created_at
    })),
    total,
    page,
    size,
    action,
    result
  };
}

async function changeAccountStatus(database, body, actor) {
  const username = readUsername(body.username);
  if (!['active', 'disabled'].includes(body.status)) throw new HttpError(400, '账号状态不合法。');
  const reason = readReason(body.reason);
  const result = await transaction(database, async connection => {
    const account = await queryOne(connection, 'SELECT id, status FROM users WHERE username = ? FOR UPDATE', [username]);
    if (!account) throw new HttpError(404, '账号不存在或已被删除。');
    if (account.status === body.status) {
      await recordAdminAudit(connection, {
        actor, action: `account_${body.status}`, target: username, result: 'no_change', detail: reason
      });
      return { changed: false, revoked: 0 };
    }
    const now = new Date().toISOString();
    if (body.status === 'disabled') {
      await connection.execute('UPDATE users SET status = ?, disabled_at = ?, disabled_reason = ? WHERE id = ?',
        ['disabled', now, reason, account.id]);
      const [deleted] = await connection.execute('DELETE FROM sessions WHERE user_id = ?', [account.id]);
      await recordAdminAudit(connection, {
        actor, action: 'account_disabled', target: username, result: 'success', detail: reason
      });
      return { changed: true, revoked: Number(deleted.affectedRows ?? 0) };
    }
    await connection.execute('UPDATE users SET status = ?, disabled_at = NULL, disabled_reason = NULL WHERE id = ?',
      ['active', account.id]);
    await recordAdminAudit(connection, {
      actor, action: 'account_restored', target: username, result: 'success', detail: reason
    });
    return { changed: true, revoked: 0 };
  });
  const detail = await accountDetail(database, { username });
  return { ...result, account: detail, checkedAt: new Date().toISOString() };
}

async function revokeSessions(database, body, actor) {
  const username = readUsername(body.username);
  const revoked = await transaction(database, async connection => {
    const row = await queryOne(connection, 'SELECT id FROM users WHERE username = ? FOR UPDATE', [username]);
    if (!row) throw new HttpError(404, '账号不存在或已被删除。');
    const [result] = await connection.execute('DELETE FROM sessions WHERE user_id = ?', [row.id]);
    await recordAdminAudit(connection, {
      actor, action: 'sessions_revoked', target: username, result: 'success', detail: `revoked=${Number(result.affectedRows ?? 0)}`
    });
    return Number(result.affectedRows ?? 0);
  });
  return { revoked, checkedAt: new Date().toISOString() };
}

async function logoutAdmin(database, session) {
  await transaction(database, async connection => {
    await connection.execute('DELETE FROM admin_sessions WHERE token_hash = ?', [digest(session.token)]);
    await recordAdminAudit(connection, { actor: session.actor, action: 'admin_logout', result: 'success' });
  });
  return { loggedOut: true };
}

async function loginAdmin(database, request, readJson, limit, remote) {
  limit(`admin-login:${remote}`, 5, 15 * 60 * 1000);
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || password.length > 128) {
    await recordAdminAudit(database, { actor: 'anonymous', action: 'admin_login', result: 'failed', detail: 'invalid_request' });
    throw new HttpError(400, '请输入管理口令。');
  }
  let ok = false;
  try {
    ok = await verifyPassword(password, passwordHash);
  } catch (error) {
    if (error instanceof HttpError) {
      await recordAdminAudit(database, { actor: 'anonymous', action: 'admin_login', result: 'failed', detail: `service_${error.status}` });
      throw error;
    }
  }
  if (!ok) {
    await recordAdminAudit(database, { actor: 'anonymous', action: 'admin_login', result: 'denied', detail: 'invalid_password' });
    throw new HttpError(401, '管理口令不正确。');
  }
  const session = await createAdminSession(database);
  return { ...session, actor: adminName, scope: 'accounts-admin', expiresIn: tokenHours * 3600 };
}

export async function adminApi(database, request, pathname, { limit, remote, readJson }) {
  if (!configured) {
    throw new HttpError(503, '账号服务尚未启用管理接口，请先在部署环境配置管理口令。', { retryAfter: 60 });
  }
  const started = Date.now();
  try {
    if (request.method !== 'POST') throw new HttpError(405, '管理接口仅支持 POST。');
    if (pathname === `${prefix}/login`) return await loginAdmin(database, request, readJson, limit, remote);

    const body = await readJson(request);
    const session = await authenticateAdmin(database, body.token);
    if (!session) {
      await recordAdminAccessDenied(database, pathname, 'invalid_admin_token');
      throw new HttpError(401, '管理会话已过期，请重新输入口令。');
    }
    limit(`admin:${remote}`, 240, 60 * 1000);

    if (pathname === `${prefix}/logout`) return await logoutAdmin(database, session);
    if (pathname === `${prefix}/overview`) return overview(database);
    if (pathname === `${prefix}/accounts`) return listAccounts(database, body);
    if (pathname === `${prefix}/account`) return accountDetail(database, body);
    if (pathname === `${prefix}/audit`) return listAudit(database, body);
    if (pathname === `${prefix}/sessions/revoke`) return revokeSessions(database, body, session.actor);
    if (pathname === `${prefix}/accounts/status`) return changeAccountStatus(database, body, session.actor);
    throw new HttpError(404, '管理接口不存在。');
  } finally {
    console.log(`[admin] ${request.method} ${pathname} ${Date.now() - started}ms`);
  }
}
