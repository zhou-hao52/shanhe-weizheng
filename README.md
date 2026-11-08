# 山河为证 · 重走长征路

团队原站网页入口：`https://zhou-hao52.github.io/shanhe-weizheng/`。使用原仓库 GitHub Pages 展示网页、阿里云 FC 提供账号 API、RDS MySQL 保存个人记录；发布与跨设备验收见 `docs/published-site.md`。

基于静态网站新增独立的个人账号与学习档案服务，已整合远程提交 `20cce21874d8daa52a7ec8e43ce7e9ad50827888` 的页面更新。

## 已实现

- 账号注册、登录、退出；昵称修改 API。
- MySQL 持久化个人到访、收藏、题目学习标记、最近浏览节点。
- 页面右下方“我的足迹”：个人数量统计、继续探索、收藏列表和自动同步状态；站内「我的山河」（`/profile`）通过只读桥接展示同一份档案，可从页脚或面板里的「查看完整个人主页」进入。
- 登录时自动合并当前游客记录；登录后自动同步，换设备登录自动读取，无需手动导入或恢复。
- 账号隔离、同步版本冲突检测、密码哈希、Bearer 会话、请求来源校验和基础限流。
- 注册账号、进度和会话的原子事务；进程存活与数据库健康检查、数据库临时故障的安全 503 响应。
- 账号数据在线备份、空库恢复和旧 SQLite 数据迁移命令。

账号模块在原主程序之外实现：加载前恢复本机档案，随后使用原页面已有的本地存储键检测变化。原主程序增加了 `shw:progress-updated` 事件桥接，云端变化可直接更新页面而不刷新答题过程；另有答题结束边界修复，详见 `docs/quiz-completion-fix.md`。原 WorkBuddy 留言、访问统计和管理员后台保持原逻辑，和本服务分开，不共享账号或数据库。

## 本地运行

要求 Node.js 24.x、MySQL 8.0+，通过 `mysql2` 驱动连接。先由数据库管理员建立数据库及专用用户（替换示例密码；应用同机部署时可使用以下配置）：

```sql
CREATE DATABASE shanhe CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'shanhe'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-database-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES ON shanhe.* TO 'shanhe'@'127.0.0.1';
```

不要让应用使用 root。远程数据库需将账号来源限制为应用服务器的内网地址，而不是开放给所有公网来源。

```sh
cp .env.example .env
npm ci
# 编辑 .env，填写真实的 MYSQL_HOST / MYSQL_PORT / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD
npm start
```

打开 `http://localhost:3000/shanhe-weizheng/`，点击“我的足迹”。请使用这里的 `localhost`，不要改成 `127.0.0.1`，除非同时调整 `PUBLIC_ORIGIN`，否则来源校验会阻止登录。

首次启动自动在指定 MySQL 数据库初始化表，不自动创建数据库或用户；重启 Node 服务不清空数据。数据库连接失败会阻止启动；`GET /api/account/health` 也会实际检查数据库连接。不再使用 `DB_FILE`，也不会自动读取旧 SQLite 文件。旧数据迁移见下文。

注册成功后直接进入个人档案并自动同步，不再生成或要求保存恢复码。目前不提供自助找回密码功能，建议使用密码管理器保存账号密码。

## 怎么验证闭环

1. 用普通浏览器注册测试账号，确认直接进入个人档案；进入历史档案页面并收藏一个节点。
2. 收藏或取消收藏后等待约 3 秒，“我的足迹”会显示“已自动同步”，无需点击同步按钮。
3. 在另一个浏览器/无痕窗口登录同一账号，确认到访和收藏一致。
4. 重启 Node 服务，再登录确认记录仍存在。
5. 两个设备分别修改：自动合并到访和学习记录，收藏按本机相对上次同步的增删合并。另一台设备前台停留约 15 秒（后台切回前台立即检查），无需刷新即可更新。
6. 断网后继续收藏，联网后自动补传。退出后进入空白游客档案，再登录另一个账号，确认不会带入前一个账号的记录。

浏览原历史详情页时，原主程序仍会向 WorkBuddy 发送原有访问请求；测试新账号 API 不需要调用该服务。不要用线上留言、清空操作做测试。

## 部署与“云端”说明

**代码写好不代表云端已经上线。** 需要将 Node 服务部署到服务器或 Serverless 平台，配置 HTTPS，并连接持久化的 MySQL。比赛演示可使用阿里云函数计算 FC + 云 MySQL，不必自己维护虚拟机；也可以沿用服务器。不要为测试直接购买资源，先确认预算和已有资源。

### 阿里云 FC + 云 MySQL

已提供整站自定义容器的 `Dockerfile`、构建白名单 `.dockerignore` 和环境变量模板 `deploy/fc/.env.example`，步骤见 `docs/fc-deployment.md`。该方案把网页和账号 API 放在同一个 HTTPS 域名，不改动原 WorkBuddy 后台。

容器默认监听 `0.0.0.0:9000`，每实例最多 2 个数据库连接，且不在冷启动时建表。先由管理员在私网环境执行 `npm run db:init`，再使用仅有业务读写权限的账号启动函数。FC 的临时文件系统不存账号数据，也不能作为备份存储。

这只是部署准备，不代表已经创建函数、购买数据库或得到公开链接。FC 默认测试域名可能将 HTML 作为附件下载；比赛网页入口应另行核实并配置 HTTPS 自定义域名。详细费用和域名要求在创建资源前确认。

### 自管服务器

推荐将此服务及现有静态文件一起部署，同一个域名同时提供网站和 `/api/account/*`。生产环境配置示例：

```dotenv
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://your-domain.example
NODE_ENV=production
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=shanhe
MYSQL_USER=shanhe
MYSQL_PASSWORD=replace-with-a-strong-database-password
MYSQL_SSL=false
```

- 由反向代理终止 HTTPS，将请求转发到 Node 服务；`PUBLIC_ORIGIN` 必须与浏览器地址完全一致。
- 只开放 HTTPS 代理，不把内部 Node 端口直接暴露到公网。
- MySQL 的数据目录必须位于持久磁盘，并做好备份；不要向公网开放 3306。
- 远程云数据库按供应商要求启用 `MYSQL_SSL=true`；需要自定义 CA 时配置 `MYSQL_SSL_CA=/安全路径/ca.pem`。始终验证证书，不提供跳过校验选项。同机 loopback 连接可使用 `MYSQL_SSL=false`。
- 当前应用的限流保存在单进程内存，仍按单个 Node 实例部署；不是完整的多实例高可用方案。FC 初期也限制最多 1 个实例，公网开放前在可信入口补充分布式限流。
- 限流按直连来源 IP 和账号生效，不信任客户端伪造的转发头。经过单一反向代理时 IP 限额为代理共享；正式开放前需在可信代理上配置限流并评估容量。
- 本仓库没有自动推送、部署、云资源创建或线上数据库迁移步骤。

### 保留 GitHub Pages

GitHub Pages 作为团队原网页入口，账号功能通过 HTTPS 跨域调用 FC API，不要求普通用户配置环境或跳转到另一个网站。

`account/config.js` 中的 `accountApi` 指向 FC 地址，`accountSite` 为团队原站 origin。FC 的 `ALLOWED_ORIGINS` 必须允许团队原站，不能设为 `*`。当前认证是 localStorage 中的 Bearer token，不是 HttpOnly Cookie；令牌会受 XSS 影响，应严格保护网页脚本来源。

网页与 API 分别发布：部署分支的改动合入原仓库 `main` 并完成 Pages 构建后才会更新原站；后端修复还需单独上传 FC 代码包。数据库结构版本为 2，升级旧库需先由具备 `ALTER` 权限的账号执行 `npm run db:init`。完整步骤见 `docs/published-site.md`。

不要把后端管理密钥、数据库文件、`.env` 或账号密码提交到 Git；`.gitignore` 已排除默认数据目录和环境文件。

## 备份与恢复

```sh
npm run backup
```

通过 InnoDB 一致性快照将账号与进度输出到 `backups/*.json`，文件权限为 0600。备份包含密码哈希和个人数据，不包含会话、恢复码或原 WorkBuddy 数据；必须保护好备份并另存到安全位置。它是本服务的应用数据备份，不替代云数据库自身的灾备策略。

恢复先在测试环境验证：停止目标 Node 服务，新建空 MySQL 数据库并配置 `.env`，然后执行：

```sh
npm run restore -- /绝对路径/备份.json
```

目标账号、进度、会话表必须全部为空，否则拒绝；所有导入在同一事务内完成，失败回滚，不覆盖已有数据。完成后启动服务，用户需重新登录。不要在服务运行或其他写入程序连接时执行恢复。

### 从旧 SQLite 迁移

保留原文件并先备份；停止旧服务和目标服务，将 `.env` 指向新建的空 MySQL 数据库，再执行：

```sh
npm run migrate:sqlite -- /绝对路径/data/shanhe.sqlite
npm start
```

只读打开指定旧库，保留账号 ID、账号名、昵称、密码哈希与进度，跳过旧会话和恢复码；原 SQLite 文件不改动。迁移后原密码仍可登录，不能只修改环境变量就认为旧数据已迁入。仅迁移工具使用 Node 内置 SQLite，可能输出实验性 API 提示。

## 当前边界

- 现有题库答案在前端。云端 `quiz` 只是 `client-reported` 学习标记，不是服务端验证成绩；没有完整答题选项、次数、时间的记录，不适合排行榜或真实资格认证。
- 原印章仍由前端判断和生成，尚未改为后端授予。
- 同步以版本校验加三方合并处理冲突：到访、学习取并集，收藏仅应用本机相对基线的增删；最近节点在本机有变化时优先本机。冲突后重新读取最新版本，最多连续尝试三次，之后自动延后重试。同一收藏的并发相反操作不是完整操作日志，按该合并规则处理。
- 前台约每 3 秒检测本机修改、约每 15 秒检查云端；网络恢复、窗口聚焦时立即检查。支持 Web Locks 的浏览器串行处理同源标签页的同步和账号操作。
- 登录失效或退出时将未同步记录保存在该浏览器的账号专属备份键，下次登录该账号自动合并；不是服务端备份。游客记录导入后不再反复导入，退出不会还原已导入的游客收藏。共享电脑使用者应自行清除本地个人数据。
- 为避免误写，登录状态下禁用原 `reset=1` 游客重置参数；不提供普通用户云端清空按钮。
- 原 WorkBuddy 管理员看板中的留言、访问统计、数据表与维护仍只读原 SQLite；新增的「账号」页通过 `/api/account/admin/*` 读取本服务，两套数据不混。管理接口需要额外的 `ADMIN_PASSWORD_HASH` 与 `ADMIN_TOKEN_SECRET`，未配置时该页只提示「尚未启用管理接口」，不影响登录与同步。`ADMIN_NAME` 用于标记管理审计中的操作者，默认 `admin`。
- 管理端已支持服务端退出、账号停用/恢复和持久化审计；停用账号会撤销其现有用户会话，但保留进度。当前管理审计只区分部署配置的操作者名称，不能区分共用同一口令的多名人员。
- 没有用户注销、邮箱验证或高并发生产压测，公开规模化运营前仍需完善。

## 目录

```text
account/       可维护的账号面板、启动适配和同步逻辑
server/        个人账号 HTTP 服务、MySQL 结构、备份恢复及迁移工具
assets/        原网站构建产物，含答题结束边界修复
docs/          原站盘点与新增 API 说明
```

所有原 HTML 入口改为加载 `account/bootstrap.js`，它再加载 `assets/index-C_ABnQIg.js`。以后更新主程序产物时，应同时更新该引用、保留 `shw:progress-updated` 缓存刷新桥接，并核对 `shw.visited.v1`、`shw.fav.v1`、`shw.quiz.v1` 的数据格式。
