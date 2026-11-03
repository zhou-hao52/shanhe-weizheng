import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { databaseConfig } from './database-config.mjs';
import { HttpError } from './security.mjs';

const temporaryDatabaseCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_SERVER_SHUTDOWN',
  'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'
]);

export function isTemporaryDatabaseError(error) {
  return temporaryDatabaseCodes.has(error.code) || (!error.code && error.message === 'Queue limit reached.');
}

export async function openDatabase(options = databaseConfig()) {
  const { autoInitialize = true, ...connectionOptions } = options;
  const database = mysql.createPool({
    ...connectionOptions,
    charset: 'utf8mb4',
    connectionLimit: connectionOptions.connectionLimit ?? 5,
    queueLimit: 100,
    connectTimeout: 10000,
    supportBigNumbers: true,
    multipleStatements: false
  });
  try {
    if (!autoInitialize) {
      const version = await queryOne(database, 'SELECT version FROM schema_version WHERE id = 1');
      if (version?.version !== 1) throw new Error('数据库尚未初始化或版本不兼容，请先执行 npm run db:init。');
      await database.execute('SELECT id, username, nickname, password_hash, created_at FROM users LIMIT 0');
      await database.execute('SELECT token_hash, user_id, expires_at FROM sessions LIMIT 0');
      await database.execute('SELECT user_id, visited_json, favorites_json, quiz_json, last_node, revision, updated_at FROM progress LIMIT 0');
      return database;
    }
    await database.execute(`CREATE TABLE IF NOT EXISTS schema_version (
      id TINYINT PRIMARY KEY, version INT NOT NULL
    ) ENGINE=InnoDB`);
    const version = await queryOne(database, 'SELECT version FROM schema_version WHERE id = 1');
    if (version && version.version !== 1) throw new Error('数据库版本与当前程序不兼容。');
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.split(';').map(value => value.trim()).filter(Boolean)) {
      await database.execute(statement);
    }
    await database.execute('INSERT IGNORE INTO schema_version (id, version) VALUES (1, 1)');
    return database;
  } catch (error) {
    await database.end();
    throw error;
  }
}

export async function queryOne(database, statement, parameters = []) {
  const [rows] = await database.execute(statement, parameters);
  return rows[0];
}

export async function transaction(database, callback) {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      connection.destroy();
    }
    throw error;
  } finally {
    connection.release();
  }
}

export async function readProgress(database, userId, lock = false) {
  const row = await queryOne(database, `SELECT * FROM progress WHERE user_id = ?${lock ? ' FOR UPDATE' : ''}`, [userId]);
  const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
  return {
    visited: decode(row.visited_json),
    favorites: decode(row.favorites_json),
    quiz: decode(row.quiz_json),
    lastNode: row.last_node,
    revision: row.revision,
    updatedAt: row.updated_at,
    quizVerification: 'client-reported'
  };
}

export function normalizeProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '进度格式错误。');
  const nodePattern = /^evt-(0[1-9]|1[0-5])$/;
  const quizPattern = /^q(0[1-9]|1[0-5])$/;
  const validateIds = (items, pattern) => {
    if (!Array.isArray(items) || items.length > 15 || items.some(item => typeof item !== 'string' || !pattern.test(item))) {
      throw new HttpError(400, '进度中包含无效或过多的节点、题目。');
    }
    return [...new Set(items)].sort();
  };
  if (value.lastNode !== null && (typeof value.lastNode !== 'string' || !nodePattern.test(value.lastNode))) {
    throw new HttpError(400, '最近节点无效。');
  }
  return {
    visited: validateIds(value.visited, nodePattern),
    favorites: validateIds(value.favorites, nodePattern),
    quiz: validateIds(value.quiz, quizPattern),
    lastNode: value.lastNode
  };
}

export async function saveProgress(database, userId, revision, value) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, '缺少有效的数据版本。');
  const progress = normalizeProgress(value);
  const [result] = await database.execute(`
    UPDATE progress SET visited_json = ?, favorites_json = ?, quiz_json = ?,
      last_node = ?, revision = revision + 1, updated_at = ?
    WHERE user_id = ? AND revision = ?
  `, [JSON.stringify(progress.visited), JSON.stringify(progress.favorites), JSON.stringify(progress.quiz),
    progress.lastNode, new Date().toISOString(), userId, revision]);
  if (result.affectedRows !== 1) throw new HttpError(409, '另一设备已更新进度，已暂停同步，请先读取云端版本。');
  return readProgress(database, userId);
}
