import { initializeAccount } from './cloud.js';

let account;
try {
  account = await initializeAccount();
} catch (error) {
  console.warn('个人档案暂时不可用，继续以原站点模式浏览。', error.name);
}
await import('../assets/index-DX5zHGyO.js');
account?.mount();
