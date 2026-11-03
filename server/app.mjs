import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, queryOne, readProgress, normalizeProgress, saveProgress, transaction } from './store.mjs';
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

export async function createApp({ databaseOptions, publicOrigin = 'http://localhost:3000', production = false, allowedOrigins = [] } = {}) {
  const originUrl = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN 必须是完整 origin，不能含路径或末尾斜线。');
  if (production && originUrl.protocol !== 'https:') throw new Error('生产环境必须配置 HTTPS PUBLIC_ORIGIN。');
  const allowed = (allowedOrigins.length ? allowedOrigins : [publicOrigin]).map(value => {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) throw new Error('ALLOWED_ORIGINS 必须是完整 origin 列表，不能含路径或末尾斜线。');
    return parsed.origin;
  });
  const limit = createLimiter();
  const dummyPassword = await hashPassword(randomSecret());
  const rootReal = await realpath(rootDirectory);
  const database = await openDatabase(databaseOptions);

  function applyCors(request, response) {
    const origin = request.headers.origin;
    if (origin && allowed.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-SHW-Client, Authorization');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      response.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function tokenFrom(request) {
    const authorization = request.headers.authorization || '';
    if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
    const part = (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
    return part?.slice(cookieName.length + 1) || '';
  }

  async function authenticated(request) {
    const token = tokenFrom(request);
    const user = await queryOne(database, `
      SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `, [digest(token), Date.now()]);
    if (!user) throw new HttpError(401, '请先登录，或重新登录已过期的账号。');
    return user;
  }

  async function issueSession(request, userId) {
    const token = randomSecret();
    await transaction(database, async connection => {
      await connection.execute('DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?', [digest(tokenFrom(request)), Date.now()]);
      await connection.execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [digest(token), userId, Date.now() + sessionLifetime]);
    });
    return { token, expiresAt: Date.now() + sessionLifetime };
  }

  async function accountState(user) {
    return { user: publicUser(user), progress: await readProgress(database, user.id) };
  }

  async function api(request, response, pathname) {
    const method = request.method;
    const remote = request.socket.remoteAddress || 'unknown';
    limit(`api:${remote}`, 300, 60000);
    if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) throw new HttpError(405, '不支持此请求方法。');
    if (method !== 'GET') {
      if (!request.headers.origin || !allowed.includes(request.headers.origin) || request.headers['x-shw-client'] !== 'account-v1') {
        throw new HttpError(403, '请求来源不受信任，请在账号服务所在网站操作。');
      }
    }
    if (pathname === `${apiPrefix}/health` && method === 'GET') {
      await queryOne(database, 'SELECT 1');
      return { service: 'shanhe-accounts', database: 'mysql', schemaVersion: 1 };
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
        try {
          await transaction(database, async connection => {
            await connection.execute('INSERT INTO users (id, username, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
              [userId, username, nickname, passwordHash, createdAt]);
            await connection.execute('INSERT INTO progress (user_id, visited_json, favorites_json, quiz_json, updated_at) VALUES (?, ?, ?, ?, ?)',
              [userId, '[]', '[]', '[]', createdAt]);
          });
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') throw new HttpError(409, '账号无法注册，请更换账号名称或尝试登录。');
          throw error;
        }
        const session = await issueSession(request, userId);
        response.statusCode = 201;
        return { ...(await accountState(await queryOne(database, 'SELECT * FROM users WHERE id = ?', [userId]))), ...session };
      }
      const user = await queryOne(database, 'SELECT * FROM users WHERE username = ?', [username]);
      const valid = await verifyPassword(body.password, user?.password_hash || dummyPassword);
      if (!user || !valid) throw new HttpError(401, '账号或密码不正确。');
      const current = await queryOne(database, 'SELECT * FROM users WHERE id = ?', [user.id]);
      if (!current || current.password_hash !== user.password_hash) throw new HttpError(401, '凭证已变更，请重新登录。');
      const session = await issueSession(request, user.id);
      return { ...(await accountState(current)), ...session };
    }
    const user = await authenticated(request);
    if (pathname === `${apiPrefix}/me` && method === 'GET') return accountState(user);
    if (pathname === `${apiPrefix}/logout` && method === 'POST') {
      await readJson(request);
      await database.execute('DELETE FROM sessions WHERE token_hash = ?', [digest(tokenFrom(request))]);
      return { loggedOut: true };
    }
    if (pathname === `${apiPrefix}/me` && method === 'PATCH') {
      const body = await readJson(request);
      if (body.expectedUserId !== user.id) throw new HttpError(409, '账号已切换，请刷新页面。');
      await database.execute('UPDATE users SET nickname = ? WHERE id = ?', [nicknameFrom(body, user.nickname), user.id]);
      return accountState(await queryOne(database, 'SELECT * FROM users WHERE id = ?', [user.id]));
    }
    if (pathname === `${apiPrefix}/progress` && method === 'PUT') {
      const body = await readJson(request);
      if (body.expectedUserId !== user.id) throw new HttpError(409, '账号已切换，已阻止同步到其他账号。');
      return { progress: await transaction(database, connection => saveProgress(connection, user.id, body.revision, body.progress)) };
    }
    if (pathname === `${apiPrefix}/import` && method === 'POST') {
      const body = await readJson(request);
      if (body.expectedUserId !== user.id || body.confirmed !== true) throw new HttpError(400, '请确认导入目标账号和游客记录。');
      const incoming = normalizeProgress(body.progress);
      return transaction(database, async connection => {
        const current = await readProgress(connection, user.id, true);
        if (body.revision !== current.revision) throw new HttpError(409, '云端进度已更新，请重新登录后再选择导入。');
        const merged = {
          visited: [...new Set([...current.visited, ...incoming.visited])].sort(),
          favorites: [...new Set([...current.favorites, ...incoming.favorites])].sort(),
          quiz: [...new Set([...current.quiz, ...incoming.quiz])].sort(),
          lastNode: current.lastNode || incoming.lastNode
        };
        return { progress: await saveProgress(connection, user.id, current.revision, merged) };
      });
    }
    throw new HttpError(404, '接口不存在。');
  }

  async function serveStatic(request, response, url) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, '不支持此请求方法。');
    if (url.pathname === '/' || url.pathname === '/shanhe-weizheng') {
      url = new URL(`${basePath}${url.search}`, url);
    }
    if (!url.pathname.startsWith(basePath)) throw new HttpError(404, '页面不存在。');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname.slice(basePath.length)); } catch { throw new HttpError(400, '路径无效。'); }
    if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.'))) throw new HttpError(404, '页面不存在。');
    if (/^(about|admin|archive|figures|quiz|route|archive\/evt-(?:0[1-9]|1[0-5]))$/.test(pathname)) {
      pathname += '/index.html';
    } else if (!pathname || pathname.endsWith('/')) {
      pathname += 'index.html';
    }
    const allowedPage = /^(index\.html|404\.html|(?:about|admin|archive|figures|quiz|route)\/index\.html|archive\/evt-(?:0[1-9]|1[0-5])\/index\.html)$/;
    const allowedAsset = /^(?:assets|art|fonts|account)\/[A-Za-z0-9_-]+\.(?:js|css|webp|woff2|svg)$/;
    if (!allowedPage.test(pathname) && !allowedAsset.test(pathname)) {
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
    applyCors(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
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
  server.on('close', () => { database.end().catch(error => console.error('Database close failed:', error.code || error.name)); });
  return { server, database };
}
