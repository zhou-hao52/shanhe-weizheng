import { readFileSync } from 'node:fs';

export function databaseConfig(environment = process.env) {
  const port = Number(environment.MYSQL_PORT || 3306);
  const connectionLimit = Number(environment.MYSQL_CONNECTION_LIMIT || 5);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_PORT 必须是有效端口。');
  if (!Number.isInteger(connectionLimit) || connectionLimit < 1 || connectionLimit > 20) throw new Error('MYSQL_CONNECTION_LIMIT 必须是 1～20 的整数。');
  if (!environment.MYSQL_USER || !environment.MYSQL_DATABASE) throw new Error('请配置 MYSQL_USER 和 MYSQL_DATABASE。');
  if (environment.NODE_ENV === 'production' && !environment.MYSQL_PASSWORD) throw new Error('生产数据库必须设置 MYSQL_PASSWORD。');
  if (environment.MYSQL_SSL && !['true', 'false'].includes(environment.MYSQL_SSL)) throw new Error('MYSQL_SSL 必须是 true 或 false。');
  if (environment.MYSQL_SSL_CA && environment.MYSQL_SSL !== 'true') throw new Error('配置 MYSQL_SSL_CA 时必须启用 MYSQL_SSL。');
  if (environment.MYSQL_AUTO_INIT && !['true', 'false'].includes(environment.MYSQL_AUTO_INIT)) throw new Error('MYSQL_AUTO_INIT 必须是 true 或 false。');
  return {
    autoInitialize: environment.MYSQL_AUTO_INIT !== 'false',
    connectionLimit,
    host: environment.MYSQL_HOST || '127.0.0.1',
    port,
    user: environment.MYSQL_USER,
    password: environment.MYSQL_PASSWORD || '',
    database: environment.MYSQL_DATABASE,
    ...(environment.MYSQL_SSL === 'true' ? {
      ssl: {
        rejectUnauthorized: true,
        verifyIdentity: true,
        ...(environment.MYSQL_SSL_CA ? { ca: readFileSync(environment.MYSQL_SSL_CA, 'utf8') } : {})
      }
    } : {})
  };
}
