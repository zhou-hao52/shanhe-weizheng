import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './store.mjs';
import { importData } from './import-data.mjs';

if (process.argv.length !== 3) throw new Error('用法：npm run migrate:sqlite -- /绝对路径/旧数据库.sqlite（目标服务必须先停止）');
const source = new DatabaseSync(resolve(process.argv[2]), { readOnly: true });
let snapshot;
try {
  source.exec('BEGIN');
  if (source.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('旧 SQLite 数据库版本不受支持。');
  snapshot = {
    format: 'shanhe-accounts', version: 1,
    users: source.prepare('SELECT id, username, nickname, password_hash, created_at FROM users').all(),
    progress: source.prepare('SELECT * FROM progress').all()
  };
  source.exec('COMMIT');
} finally {
  source.close();
}
const database = await openDatabase();
try {
  const count = await importData(database, snapshot);
  console.log(`已迁移 ${count} 个账号及进度，原 SQLite 文件保持不变。会话与恢复码不迁移，请重新登录。`);
} finally {
  await database.end();
}
