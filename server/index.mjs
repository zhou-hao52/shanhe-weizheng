import { createApp } from './app.mjs';

process.umask(0o077);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
const { server } = await createApp({
  publicOrigin,
  production: process.env.NODE_ENV === 'production',
  allowedOrigins
});
server.listen(port, host, () => console.log(`山河为证已启动：${publicOrigin}/shanhe-weizheng/`));
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
    deadline.unref();
    server.close();
    server.closeIdleConnections();
  });
}
