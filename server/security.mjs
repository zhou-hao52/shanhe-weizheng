import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const cost = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let activeHashes = 0;

export class HttpError extends Error {
  constructor(status, message, { retryAfter } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const randomSecret = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');

export function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 6 || password.length > 128) {
    throw new HttpError(400, '密码需要 6～128 个字符。');
  }
}

async function passwordKey(password, salt) {
  if (activeHashes >= 2) throw new HttpError(503, '登录服务繁忙，请稍后再试。', { retryAfter: 1 });
  activeHashes += 1;
  try {
    return await deriveKey(password, salt, 64, cost);
  } finally {
    activeHashes -= 1;
  }
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  const key = await passwordKey(password, salt);
  return `scrypt$131072$8$1$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const parts = encoded.split('$');
  const expected = Buffer.from(parts[5], 'hex');
  const actual = await passwordKey(password, parts[4]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createLimiter() {
  const buckets = new Map();
  return (key, maximum, windowMs = 15 * 60 * 1000) => {
    const now = Date.now();
    for (const [entry, bucket] of buckets) {
      if (bucket.expiresAt <= now) buckets.delete(entry);
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= 10000) throw new HttpError(503, '服务繁忙，请稍后再试。', { retryAfter: 60 });
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) throw new HttpError(429, '操作过于频繁，请稍后再试。', {
      retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))
    });
  };
}
