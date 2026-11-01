import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, readProgress, normalizeProgress, saveProgress, transaction } from './store.mjs';
import { HttpError, randomSecret, digest, hashPassword, verifyPassword, validatePassword, createLimiter } from './security.mjs';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const basePath = '/shanhe-weizheng/';
const apiPrefix = '/api/account';
const cookieName = 'shw_session';
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml'
};

function publicUser(user) {
  return { id: user.id, username: user.username, nickname: user.nickname, createdAt: user.created_at };
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, '请使用 JSON 请求。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON 格式错误。');
  }
}

function usernameFrom(body) {
  if (typeof body.username !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(body.username)) {
    throw new HttpError(400, '账号需为 3～24 位字母、数字或下划线。');
  }
  return body.username.toLowerCase();
}

function nicknameFrom(body, fallback) {
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : fallback;
  if (!nickname || [...nickname].length > 24) throw new HttpError(400, '昵称需为 1～24 个字符。');
  return nickname;
}

export async function createApp({ databaseFile = './data/shanhe.sqlite', publicOrigin = 'http://localhost:3000', production = false } = {}) {
  const originUrl = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN 必须是完整 origin，不能含路径或末尾斜线。');
  if (production && originUrl.protocol !== 'https:') throw new Error('生产环境必须配置 HTTPS PUBLIC_ORIGIN。');
  const secureCookie = originUrl.protocol === 'https:';
  const database = openDatabase(databaseFile);
  const limit = createLimiter();
  const dummyPassword = await hashPassword(randomSecret());
  const rootReal = await realpath(rootDirectory);

  function sessionCookie(token, age = sessionLifetime / 1000) {
    return `${cookieName}=${token}; Path=${apiPrefix}; HttpOnly; SameSite=Strict; Max-Age=${age}${secureCookie ? '; Secure' : ''}`;
  }

  function tokenFrom(request) {
    const part = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
    return part?.slice(cookieName.length + 1) || '';
  }

  function authenticated(request) {
    const token = tokenFrom(request);
    const user = database.prepare(`
      SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(digest(token), Date.now());
    if (!user) throw new HttpError(401, '请先登录，或重新登录已过期的账号。');
    return user;
  }

  function issueSession(request, response, userId) {
    const token = randomSecret();
    database.prepare('DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?').run(digest(tokenFrom(request)), Date.now());
    database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(digest(token), userId, Date.now() + sessionLifetime);
    response.setHeader('Set-Cookie', sessionCookie(token));
  }

  function accountState(user) {
    return { user: publicUser(user), progress: readProgress(database, user.id) };
  }

  async function api(request, response, pathname) {
    const method = request.method;
    const remote = request.socket.remoteAddress || 'unknown';
    limit(`api:${remote}`, 300, 60000);
    if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new HttpError(405, '不支持此请求方法。');
    if (method !== 'GET') {
      if (request.headers.origin !== publicOrigin || request.headers['x-shw-client'] !== 'account-v1') {
        throw new HttpError(403, '请求来源不受信任，请在账号服务所在网站操作。');
      }
    }
    if (pathname === `${apiPrefix}/health` && method === 'GET') {
      database.prepare('SELECT 1').get();
      return { service: 'shanhe-accounts', schemaVersion: 1 };
    }
    const authPaths = ['register', 'login'].map(action => `${apiPrefix}/${action}`);
    if (authPaths.includes(pathname) && method === 'POST') {
      limit(`auth-ip:${remote}`, 30);
      const body = await readJson(request);
      const username = usernameFrom(body);
      limit(`auth-user:${username}`, 15);
      validatePassword(body.password);
      if (pathname.endsWith('/register')) {
        const nickname = nicknameFrom(body, username);
        const passwordHash = await hashPassword(body.password);
        const userId = randomUUID();
        const createdAt = new Date().toISOString();
        transaction(database, () => {
          if (database.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw new HttpError(409, '账号无法注册，请更换账号名称或尝试登录。');
          database.prepare('INSERT INTO users (id, username, nickname, password_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(userId, username, nickname, passwordHash, '', createdAt);
          database.prepare('INSERT INTO progress (user_id, updated_at) VALUES (?, ?)').run(userId, createdAt);
        });
        issueSession(request, response, userId);
        response.statusCode = 201;
        return accountState(database.prepare('SELECT * FROM users WHERE id = ?').get(userId));
      }
      const user = database.prepare('SELECT * FROM users WHERE username = ?').get(username);
      const valid = await verifyPassword(body.password, user?.password_hash || dummyPassword);
      if (!user || !valid) throw new HttpError(401, '账号或密码不正确。');
      const current = database.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (current.password_hash !== user.password_hash) throw new HttpError(401, '凭证已变更，请重新登录。');
      issueSession(request, response, user.id);
      return accountState(current);
    }
    const user = authenticated(request);
    if (pathname === `${apiPrefix}/me` && method === 'GET') return accountState(user);
    if (pathname === `${apiPrefix}/logout` && method === 'POST') {
      await readJson(request);
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(tokenFrom(request)));
      response.setHeader('Set-Cookie', sessionCookie('', 0));
      return { loggedOut: true };
    }
    if (pathname === `${apiPrefix}/me` && method === 'PATCH') {
      const body = await readJson(request);
      if (body.expectedUserId !== user.id) throw new HttpError(409, '账号已切换，请刷新页面。');
      database.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nicknameFrom(body, user.nickname), user.id);
      return accountState(database.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
    }
    if (pathname === `${apiPrefix}/progress` && method === 'PUT') {
      const body = await readJson(request);
      if (body.expectedUserId !== user.id) throw new HttpError(409, '账号已切换，已阻止同步到其他账号。');
      return { progress: saveProgress(database, user.id, body.revision, body.progress) };
    }
    if (pathname === `${apiPrefix}/import` && method === 'POST') {
      const body = await readJson(request);
      if (body.expectedUserId !== user.id || body.confirmed !== true) throw new HttpError(400, '请确认导入目标账号和游客记录。');
      const incoming = normalizeProgress(body.progress);
      return transaction(database, () => {
        const current = readProgress(database, user.id);
        if (body.revision !== current.revision) throw new HttpError(409, '云端进度已更新，请重新登录后再选择导入。');
        const merged = {
          visited: [...new Set([...current.visited, ...incoming.visited])].sort(),
          favorites: [...new Set([...current.favorites, ...incoming.favorites])].sort(),
          quiz: [...new Set([...current.quiz, ...incoming.quiz])].sort(),
          lastNode: current.lastNode || incoming.lastNode
        };
        return { progress: saveProgress(database, user.id, current.revision, merged) };
      });
    }
    throw new HttpError(404, '接口不存在。');
  }

  async function serveStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '不支持此请求方法。');
    if (url.pathname === '/' || url.pathname === '/shanhe-weizheng') {
      response.writeHead(302, { Location: `${basePath}${url.search}` });
      response.end();
      return;
    }
    if (!url.pathname.startsWith(basePath)) throw new HttpError(404, '页面不存在。');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname.slice(basePath.length)); } catch { throw new HttpError(400, '路径无效。'); }
    if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) throw new HttpError(404, '页面不存在。');
    if (!pathname || pathname.endsWith('/')) pathname += 'index.html';
    const allowedPage = /^(index\.html|404\.html|(?:about|admin|archive|figures|quiz|route)\/index\.html|archive\/evt-(?:0[1-9]|1[0-5])\/index\.html)$/;
    const allowedAsset = /^(?:assets|art|fonts|account)\/[A-Za-z0-9_-]+\.(?:js|css|webp|woff2|svg)$/;
    if (!allowedPage.test(pathname) && !allowedAsset.test(pathname)) {
      if (/^(about|admin|archive|figures|quiz|route|archive\/evt-(0[1-9]|1[0-5]))$/.test(pathname)) {
        response.writeHead(302, { Location: `${basePath}${pathname}/${url.search}` });
        response.end();
        return;
      }
      throw new HttpError(404, '页面不存在。');
    }
    let filename;
    try {
      filename = await realpath(resolve(rootDirectory, pathname));
      if (!filename.startsWith(`${rootReal}${sep}`) || !(await stat(filename)).isFile()) throw new Error();
    } catch { throw new HttpError(404, '文件不存在。'); }
    const buffer = await readFile(filename);
    response.writeHead(200, { 'Content-Type': contentTypes[extname(filename)], 'Content-Length': buffer.length, 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : buffer);
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const url = new URL(request.url, publicOrigin);
      if (url.pathname.startsWith('/api/')) {
        response.setHeader('Cache-Control', 'no-store');
        if (!url.pathname.startsWith(`${apiPrefix}/`)) throw new HttpError(404, '此服务仅提供个人账号 API，原管理后台仍独立运行。');
        const data = await api(request, response, url.pathname);
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ code: 0, data }));
      } else {
        await serveStatic(request, response, url);
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('Request failed:', error.code || error.name);
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '900' } : {}) });
      response.end(JSON.stringify({ code: status, message: status === 500 ? '服务暂时不可用，请稍后重试。' : error.message }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => database.close());
  return { server, database };
}
