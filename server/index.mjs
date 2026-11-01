import { resolve } from 'node:path';
import { createApp } from './app.mjs';

process.umask(0o077);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const { server } = await createApp({
  databaseFile: resolve(process.env.DB_FILE || './data/shanhe.sqlite'),
  publicOrigin,
  production: process.env.NODE_ENV === 'production'
});
server.listen(port, host, () => console.log(`山河为证已启动：${publicOrigin}/shanhe-weizheng/`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
