import { accountSite, accountApi } from './config.js';

const keys = {
  visited: 'shw.visited.v1', favorites: 'shw.fav.v1', quiz: 'shw.quiz.v1',
  lastNode: 'shw.last-node.v1', owner: 'shw.cloud.owner.v1', guest: 'shw.guest.backup.v1', token: 'shw.token.v1'
};
const nodePattern = /^evt-(0[1-9]|1[0-5])$/;
const quizPattern = /^q(0[1-9]|1[0-5])$/;
const emptyProgress = () => ({ visited: [], favorites: [], quiz: [], lastNode: null });

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function cleanProgress(value) {
  const clean = (items, pattern) => Array.isArray(items) ? [...new Set(items.filter(item => typeof item === 'string' && pattern.test(item)))].sort() : [];
  return {
    visited: clean(value?.visited, nodePattern),
    favorites: clean(value?.favorites, nodePattern),
    quiz: clean(value?.quiz, quizPattern),
    lastNode: typeof value?.lastNode === 'string' && nodePattern.test(value.lastNode) ? value.lastNode : null
  };
}

function localProgress() {
  return cleanProgress(Object.fromEntries(['visited', 'favorites', 'quiz', 'lastNode'].map(name => [name, readStored(keys[name], null)])));
}

function writeProgress(progress) {
  for (const [name, value] of Object.entries(cleanProgress(progress))) localStorage.setItem(keys[name], JSON.stringify(value));
  dispatchEvent(new Event('shw:progress-updated'));
}

function sameProgress(left, right) {
  return JSON.stringify(cleanProgress(left)) === JSON.stringify(cleanProgress(right));
}

function saveOwner(state) {
  localStorage.setItem(keys.owner, JSON.stringify({ userId: state.user.id, revision: state.progress.revision, baseline: cleanProgress(state.progress) }));
}

function mergeProgress(baseline, local, remote) {
  baseline = cleanProgress(baseline);
  local = cleanProgress(local);
  remote = cleanProgress(remote);
  const favorites = new Set(remote.favorites);
  for (const nodeId of baseline.favorites) if (!local.favorites.includes(nodeId)) favorites.delete(nodeId);
  for (const nodeId of local.favorites) if (!baseline.favorites.includes(nodeId)) favorites.add(nodeId);
  return cleanProgress({
    visited: [...remote.visited, ...local.visited],
    quiz: [...remote.quiz, ...local.quiz],
    favorites: [...favorites],
    lastNode: local.lastNode !== baseline.lastNode ? local.lastNode : remote.lastNode
  });
}

function withAccountLock(callback) {
  return navigator.locks ? navigator.locks.request('shw-account-sync', callback) : callback();
}

async function request(path, method = 'GET', body) {
  let response;
  try {
    const headers = { 'Content-Type': 'application/json', 'X-SHW-Client': 'account-v1' };
    const token = localStorage.getItem(keys.token);
    if (token) headers.Authorization = `Bearer ${token}`;
    response = await fetch(`${accountApi}/api/account${path}`, {
      method, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers, ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw Object.assign(new Error('暂时无法连接，记录保留在本机，联网后会自动同步。'), { status: 0 });
  }
  let result;
  try { result = await response.json(); } catch {
    throw Object.assign(new Error('账号服务暂不可用，请稍后再试。'), { status: response.status });
  }
  if (!response.ok || result.code !== 0) throw Object.assign(new Error(result.message || '账号服务暂时不可用。'), { status: response.status });
  return result.data;
}

export async function initializeAccount() {
  let storageAvailable = true;
  try {
    localStorage.setItem('shw.storage-probe', '1');
    localStorage.removeItem('shw.storage-probe');
  } catch { storageAvailable = false; }
  let state = null;
  let message = '游客模式：记录仅保存在当前浏览器。';
  let available = storageAvailable;
  let syncing = false;
  let panel;
  let authenticating = false;
  let lastCheck = 0;
  let lastPath;

  // ---------- 只读桥接 ----------
  // 站点页面（/profile）通过 globalThis.__shwAccount 读取登录态与同步状态。
  // 只暴露用户可读信息，不含内部用户 ID、令牌、进度版本。
  const BRIDGE_EVENT = 'shw:account-changed';
  let pendingOpen = false;
  let bridgeSnapshot = Object.freeze({
    version: 1, ready: false, authed: false, username: '', nickname: '', memberSince: null,
    available, syncing, message, panelReady: false, lastNode: null, updatedAt: null, endpoint: accountApi
  });

  function bridgeState() {
    const progress = localProgress();
    return {
      version: 1,
      ready: true,
      authed: !!state,
      username: state?.user.username ?? '',
      nickname: state?.user.nickname ?? '',
      memberSince: state?.user.createdAt ?? null,
      available,
      syncing,
      message,
      panelReady: !!panel,
      lastNode: progress.lastNode,
      updatedAt: state?.progress.updatedAt ?? null,
      endpoint: accountApi
    };
  }

  function publishBridge() {
    const next = Object.freeze(bridgeState());
    if (JSON.stringify(next) === JSON.stringify(bridgeSnapshot)) return;
    bridgeSnapshot = next;
    dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: next }));
  }

  function openPanel() {
    if (!panel) { pendingOpen = true; return false; }
    showCounts();
    showAccount();
    const dialog = element('dialog');
    if (dialog && !dialog.open) dialog.showModal();
    return true;
  }

  globalThis.__shwAccount = {
    version: 1,
    getSnapshot: () => bridgeSnapshot,
    subscribe: listener => {
      addEventListener(BRIDGE_EVENT, listener);
      return () => removeEventListener(BRIDGE_EVENT, listener);
    },
    open: openPanel,
    refresh: () => { if (state) sync(true); }
  };

  function retainAccount() {
    const owner = readStored(keys.owner, null);
    if (owner && !sameProgress(localProgress(), owner.baseline)) {
      localStorage.setItem(`shw.unsynced.${owner.userId}`, JSON.stringify({ baseline: owner.baseline, progress: localProgress() }));
    }
  }

  function adopt(current) {
    const owner = readStored(keys.owner, null);
    const saved = readStored(`shw.unsynced.${current.user.id}`, null);
    const remote = saved ? mergeProgress(saved.baseline, saved.progress || saved, current.progress) : current.progress;
    let progress;
    if (owner?.userId === current.user.id) {
      progress = mergeProgress(owner.baseline, localProgress(), remote);
    } else {
      retainAccount();
      progress = remote;
      if (!owner) progress = mergeProgress(emptyProgress(), localProgress(), progress);
    }
    writeProgress(progress);
    saveOwner(current);
    localStorage.removeItem(`shw.unsynced.${current.user.id}`);
    localStorage.removeItem(keys.guest);
    state = current;
    available = true;
    const url = new URL(location.href);
    if (url.searchParams.has('reset')) {
      url.searchParams.delete('reset');
      history.replaceState(null, '', url);
    }
  }

  function becomeGuest() {
    if (readStored(keys.owner, null)) {
      retainAccount();
      writeProgress(emptyProgress());
      localStorage.removeItem(keys.owner);
      localStorage.removeItem(keys.guest);
    }
    state = null;
  }

  const element = id => panel?.getElementById(id);
  function notice(text) {
    message = text;
    if (element('status')) element('status').textContent = text;
    publishBridge();
  }

  function showCounts() {
    if (!state || !panel) return;
    const progress = localProgress();
    element('visited-count').textContent = progress.visited.length;
    element('quiz-count').textContent = progress.quiz.length;
    element('favorites-count').textContent = progress.favorites.length;
    element('resume').href = progress.lastNode ? `/shanhe-weizheng/archive/${progress.lastNode}/` : '/shanhe-weizheng/route/';
    const list = element('favorites');
    list.replaceChildren();
    for (const nodeId of progress.favorites) {
      const link = document.createElement('a');
      link.href = `/shanhe-weizheng/archive/${nodeId}/`;
      link.textContent = `第 ${Number(nodeId.slice(4))} 站`;
      list.append(link);
    }
    element('empty-favorites').hidden = progress.favorites.length > 0;
  }

  function showAccount() {
    if (!panel) return;
    element('anonymous').hidden = !available || !!state;
    element('profile').hidden = !state;
    element('unavailable').hidden = available || !!state;
    if (state) {
      element('greeting').textContent = `${state.user.nickname}，欢迎回来`;
      element('account-name').textContent = `账号：${state.user.username}`;
      showCounts();
    }
    publishBridge();
  }

  async function sync(force = false) {
    if (!storageAvailable || syncing || authenticating) return;
    const owner = readStored(keys.owner, null);
    const changed = owner && (!sameProgress(localProgress(), owner.baseline) || lastPath !== location.pathname);
    if (!force && !changed && Date.now() - lastCheck < (available ? 15000 : 6000)) return;
    syncing = true;
    publishBridge();
    try {
      await withAccountLock(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = await request('/me');
          adopt(current);
          if (lastPath !== location.pathname) {
            lastPath = location.pathname;
            const currentNode = lastPath.match(/\/archive\/(evt-(?:0[1-9]|1[0-5]))\/?$/);
            if (currentNode) {
              localStorage.setItem(keys.lastNode, JSON.stringify(currentNode[1]));
              publishBridge();
            }
          }
          const snapshot = localProgress();
          if (sameProgress(snapshot, state.progress)) {
            notice('已自动同步');
            return;
          }
          try {
            const result = await request('/progress', 'PUT', {
              expectedUserId: state.user.id, revision: state.progress.revision, progress: snapshot
            });
            writeProgress(mergeProgress(snapshot, localProgress(), result.progress));
            state.progress = result.progress;
            saveOwner(state);
            notice(sameProgress(localProgress(), state.progress) ? '已自动同步' : '正在自动同步…');
            return;
          } catch (error) {
            if (error.status !== 409) throw error;
          }
        }
        notice('正在合并最新记录，稍后自动重试…');
      });
    } catch (error) {
      if (error.status === 401) {
        const hadAccount = !!readStored(keys.owner, null);
        localStorage.removeItem(keys.token);
        becomeGuest();
        available = true;
        notice(hadAccount ? '登录已过期，重新登录后将自动同步。' : '登录后，足迹将自动同步。');
      } else {
        available = false;
        notice(error.message);
      }
    } finally {
      lastCheck = Date.now();
      syncing = false;
      showAccount();
    }
  }

  if (storageAvailable) await sync(true);
  else notice('浏览器禁止本地存储，暂不能安全切换账号；仍可浏览原网站。');
  publishBridge();

  function mount() {
    const host = document.createElement('div');
    host.id = 'shanhe-account';
    document.body.append(host);
    panel = host.attachShadow({ mode: 'open' });
    panel.innerHTML = `
      <link rel="stylesheet" href="${new URL('./cloud.css', import.meta.url).href}">
      <button class="launcher" id="open" aria-haspopup="dialog">我的足迹 <span aria-hidden="true">↗</span></button>
      <dialog id="dialog" aria-labelledby="title" aria-describedby="status">
        <header><div><p class="eyebrow">MY JOURNEY · 个人档案</p><h2 id="title">把足迹，留在山河间</h2></div><button id="close" class="close" aria-label="关闭个人档案">×</button></header>
        <p id="status" class="status" role="status" aria-live="polite"></p>
        <section id="unavailable" hidden><p>你可以继续浏览，连接恢复后会自动重试。</p><a id="account-site" hidden rel="noopener">前往账号服务网站 →</a></section>
        <section id="anonymous">
          <div class="tabs" role="group" aria-label="账号操作"><button id="login-tab" type="button" aria-pressed="true">登录</button><button id="register-tab" type="button" aria-pressed="false">注册</button></div>
          <form id="auth-form">
            <label>账号<input id="username" name="username" autocomplete="username" pattern="[A-Za-z0-9_]{3,24}" minlength="3" maxlength="24" required placeholder="3～24 位字母、数字或下划线"></label>
            <label id="nickname-label" hidden>昵称<input id="nickname" name="nickname" autocomplete="nickname" maxlength="24" placeholder="如何称呼你"></label>
            <label id="password-label"><span id="password-title">密码</span><input id="password" name="password" type="password" autocomplete="current-password" minlength="6" maxlength="128" required placeholder="6～128 个字符"></label>
            <button class="primary" id="submit" type="submit">登录并继续</button>
          </form>
        </section>
        <section id="profile" hidden>
          <h3 id="greeting"></h3><p id="account-name" class="fine"></p>
          <div class="counts"><div><b id="visited-count">0</b><span>到访 / 15 站</span></div><div><b id="quiz-count">0</b><span>学习 / 15 题</span></div><div><b id="favorites-count">0</b><span>收藏</span></div></div>
          <a id="resume" class="primary" href="/shanhe-weizheng/route/">继续探索 →</a>
          <h3>我的收藏</h3><div id="favorites" class="favorites"></div><p id="empty-favorites" class="fine">在历史档案中点击收藏，这里会记录你的选择。</p>
          <a id="full-profile" class="profile-link" href="/shanhe-weizheng/profile/">查看完整个人主页 →</a>
          <button id="logout" class="logout">退出账号，返回游客模式</button>
        </section>
      </dialog>`;
    notice(message);
    showAccount();
    if (pendingOpen) { pendingOpen = false; openPanel(); }
    if (accountSite) {
      try {
        const destination = new URL(accountSite);
        if (destination.protocol === 'https:' && !destination.username && !destination.password) {
          element('account-site').href = `${destination.origin}/shanhe-weizheng/`;
          element('account-site').hidden = false;
        }
      } catch { }
    }
    element('open').addEventListener('click', () => { showCounts(); element('dialog').showModal(); });
    element('close').addEventListener('click', () => element('dialog').close());
    let mode = 'login';
    for (const action of ['login', 'register']) {
      element(`${action}-tab`).addEventListener('click', () => {
        mode = action;
        for (const name of ['login', 'register']) element(`${name}-tab`).setAttribute('aria-pressed', String(name === action));
        element('nickname-label').hidden = action !== 'register';
        element('password').autocomplete = action === 'login' ? 'current-password' : 'new-password';
        element('submit').textContent = { login: '登录并继续', register: '注册个人账号' }[action];
      });
    }
    element('auth-form').addEventListener('submit', async event => {
      event.preventDefault();
      element('submit').disabled = true;
      authenticating = true;
      const action = mode;
      const credentials = {
        username: element('username').value.trim(), nickname: element('nickname').value.trim() || undefined,
        password: element('password').value
      };
      try {
        await withAccountLock(async () => {
          const result = await request(`/${action}`, 'POST', credentials);
          adopt(result);
          if (result.token) localStorage.setItem(keys.token, result.token);
        });
        element('password').value = '';
        notice('正在自动同步…');
      } catch (error) { notice(error.message); }
      finally {
        authenticating = false;
        element('submit').disabled = false;
        showAccount();
        if (state) sync(true);
      }
    });
    element('logout').addEventListener('click', async () => {
      if (syncing) return notice('正在自动同步，请稍后退出。');
      element('logout').disabled = true;
      await sync(true);
      syncing = true;
      try {
        await withAccountLock(async () => {
          await request('/logout', 'POST', {});
          localStorage.removeItem(keys.token);
          becomeGuest();
        });
        notice('已退出账号，登录后足迹将自动同步。');
      } catch (error) { notice(error.message); }
      finally {
        syncing = false;
        element('logout').disabled = false;
        showAccount();
      }
    });
    addEventListener('storage', event => {
      if (Object.values(keys).includes(event.key) || event.key === null) {
        dispatchEvent(new Event('shw:progress-updated'));
        showCounts();
        publishBridge();
        if (event.key === keys.owner || event.key === null) sync(true);
      }
    });
    addEventListener('beforeunload', event => {
      const owner = readStored(keys.owner, null);
      if (owner && !sameProgress(localProgress(), owner.baseline)) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      showCounts();
      sync();
    }, 3000);
    addEventListener('online', () => sync(true));
    addEventListener('focus', () => sync(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync(true);
    });
  }
  return { mount };
}
