import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

process.umask(0o077);
const source = resolve(process.env.DB_FILE || './data/shanhe.sqlite');
if (!existsSync(source)) throw new Error('数据库不存在，请先启动服务。');
mkdirSync('backups', { recursive: true, mode: 0o700 });
const destination = resolve('backups', `shanhe-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
const database = new DatabaseSync(source, { readOnly: true });
try {
  await backup(database, destination);
  console.log(`备份完成：${destination}`);
} finally {
  database.close();
}
