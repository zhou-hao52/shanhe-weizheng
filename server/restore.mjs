import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './store.mjs';
import { importData } from './import-data.mjs';

if (process.argv.length !== 3) throw new Error('用法：npm run restore -- /绝对路径/备份.json（目标服务必须先停止）');
const snapshot = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8'));
const database = await openDatabase();
try {
  const count = await importData(database, snapshot);
  console.log(`已恢复 ${count} 个账号及进度。旧会话未恢复，请重新登录。`);
} finally {
  await database.end();
}
