import { normalizeProgress, queryOne, transaction } from './store.mjs';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

export async function importData(database, snapshot) {
  if (snapshot?.format !== 'shanhe-accounts' || snapshot.version !== 1 || !Array.isArray(snapshot.users) || !Array.isArray(snapshot.progress)) {
    throw new Error('不是受支持的山河为证数据备份。');
  }
  const userIds = new Set();
  const usernames = new Set();
  for (const user of snapshot.users) {
    if (!user || typeof user.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(user.id)
      || typeof user.username !== 'string' || !/^[a-z0-9_]{3,24}$/.test(user.username)
      || typeof user.nickname !== 'string' || !user.nickname.trim() || [...user.nickname].length > 24
      || typeof user.password_hash !== 'string' || !/^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.password_hash)
      || !validDate(user.created_at) || userIds.has(user.id) || usernames.has(user.username)) {
      throw new Error('备份中存在无效或重复账号，未导入。');
    }
    userIds.add(user.id);
    usernames.add(user.username);
  }
  const progressIds = new Set();
  const progress = snapshot.progress.map(row => {
    if (!row || !userIds.has(row.user_id) || progressIds.has(row.user_id)
      || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > 4294967295 || !validDate(row.updated_at)) {
      throw new Error('备份中存在无效或重复进度，未导入。');
    }
    progressIds.add(row.user_id);
    const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
    const value = normalizeProgress({ visited: decode(row.visited_json), favorites: decode(row.favorites_json), quiz: decode(row.quiz_json), lastNode: row.last_node });
    return { ...row, value };
  });
  if (progressIds.size !== userIds.size) throw new Error('备份缺少部分账号的进度，未导入。');
  await transaction(database, async connection => {
    const counts = await queryOne(connection, 'SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM progress) + (SELECT COUNT(*) FROM sessions) AS total');
    if (Number(counts.total) !== 0) throw new Error('目标数据库不是空库，已拒绝覆盖。请停止目标服务并使用全新数据库。');
    for (const user of snapshot.users) {
      await connection.execute('INSERT INTO users (id, username, nickname, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [user.id, user.username, user.nickname, user.password_hash, user.created_at]);
    }
    for (const row of progress) {
      await connection.execute('INSERT INTO progress (user_id, visited_json, favorites_json, quiz_json, last_node, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.user_id, JSON.stringify(row.value.visited), JSON.stringify(row.value.favorites), JSON.stringify(row.value.quiz), row.value.lastNode, row.revision, row.updated_at]);
    }
  });
  return snapshot.users.length;
}
