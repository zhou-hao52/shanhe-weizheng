import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HttpError } from './security.mjs';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) {
    database.close();
    throw new Error('数据库版本高于当前程序，拒绝降级打开。');
  }
  database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return database;
}

export function transaction(database, callback) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function readProgress(database, userId) {
  const row = database.prepare('SELECT * FROM progress WHERE user_id = ?').get(userId);
  return {
    visited: JSON.parse(row.visited_json),
    favorites: JSON.parse(row.favorites_json),
    quiz: JSON.parse(row.quiz_json),
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

export function saveProgress(database, userId, revision, value) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, '缺少有效的数据版本。');
  const progress = normalizeProgress(value);
  const result = database.prepare(`
    UPDATE progress SET visited_json = ?, favorites_json = ?, quiz_json = ?,
      last_node = ?, revision = revision + 1, updated_at = ?
    WHERE user_id = ? AND revision = ?
  `).run(JSON.stringify(progress.visited), JSON.stringify(progress.favorites), JSON.stringify(progress.quiz),
    progress.lastNode, new Date().toISOString(), userId, revision);
  if (result.changes !== 1) throw new HttpError(409, '另一设备已更新进度，已暂停同步，请先读取云端版本。');
  return readProgress(database, userId);
}
