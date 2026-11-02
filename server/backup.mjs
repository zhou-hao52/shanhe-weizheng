import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './store.mjs';

process.umask(0o077);
const database = await openDatabase();
try {
  const connection = await database.getConnection();
  let snapshot;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [users] = await connection.execute('SELECT id, username, nickname, password_hash, created_at FROM users ORDER BY id');
    const [progress] = await connection.execute('SELECT * FROM progress ORDER BY user_id');
    snapshot = { format: 'shanhe-accounts', version: 1, createdAt: new Date().toISOString(), users, progress };
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  mkdirSync('backups', { recursive: true, mode: 0o700 });
  const destination = resolve('backups', `shanhe-${new Date().toISOString().replaceAll(':', '-')}.json`);
  writeFileSync(destination, JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`备份完成（不含会话）：${destination}`);
} finally {
  await database.end();
}
