import { databaseConfig } from './database-config.mjs';
import { openDatabase } from './store.mjs';

process.umask(0o077);
try {
  const database = await openDatabase({ ...databaseConfig(), autoInitialize: true });
  await database.end();
  console.log('数据库结构已初始化；现有账号和进度未清空。');
} catch (error) {
  console.error('数据库初始化失败：', error.code || error.name);
  process.exitCode = 1;
}
