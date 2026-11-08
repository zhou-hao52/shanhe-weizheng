# 个人账号 API v1

此文档描述新增服务，不替代原 WorkBuddy 接口。前缀为 `/api/account`，支持团队 GitHub Pages 通过来源白名单跨域调用。认证使用 `Authorization: Bearer <token>`，注册和登录返回七天有效的令牌。现有前端将令牌保存在 localStorage；它不是 HttpOnly Cookie，需防范 XSS，不加载不受信任的脚本。服务兼容读取旧 `shw_session` Cookie，但不签发或清除 Cookie。

写请求需 `Content-Type: application/json`、`X-SHW-Client: account-v1`，且 `Origin` 在 `ALLOWED_ORIGINS` 中（未配置时使用 `PUBLIC_ORIGIN`）。生产环境来源必须为 HTTPS，不允许通配符。CORS 允许 Authorization 请求头，并向合法来源暴露 Retry-After；不接受前端传入的任意用户 ID 作为身份。

返回格式：成功 `{"code":0,"data":{...}}`，失败 `{"code":HTTP状态码,"message":"说明"}`。个人数据响应禁止缓存。

## 路由

| 方法 | 路径 | 请求体 | 结果 |
| --- | --- | --- | --- |
| GET | `/live` | 无 | 进程存活，不访问数据库，不占用业务限流配额 |
| GET | `/health` | 无 | 服务及数据库健康信息 |
| POST | `/register` | `username, password, nickname?` | 原子创建账号、进度和会话，返回 `user, progress, token, expiresAt` |
| POST | `/login` | `username, password` | 创建会话，返回 `user, progress, token, expiresAt` |
| POST | `/logout` | `{}` | 撤销当前会话；客户端删除本机令牌 |
| GET | `/me` | 无 | 当前用户与个人进度 |
| PATCH | `/me` | `expectedUserId, nickname` | 更新昵称，返回用户与进度 |
| PUT | `/progress` | `expectedUserId, revision, progress` | 按版本保存，返回新进度 |
| POST | `/import` | `expectedUserId, revision, confirmed: true, progress` | 合并游客数组，保留云端已有最近节点；返回新进度 |

`username` 为 3～24 位 ASCII 字母、数字或下划线，统一转小写。密码至少 6 个字符、最多 128 个 UTF-16 代码单元；昵称为 1～24 个 Unicode 码点。注册后直接登录并自动同步，不提供自助找回密码功能。

## 进度格式

```json
{
  "visited": ["evt-01"],
  "favorites": ["evt-01"],
  "quiz": ["q01"],
  "lastNode": "evt-01",
  "revision": 1,
  "updatedAt": "服务端 ISO 时间",
  "quizVerification": "client-reported"
}
```

客户端写入的 `progress` 只需 `visited, favorites, quiz, lastNode`；revision 位于外层。每个数组最多 15 项，节点限 `evt-01`～`evt-15`，题目限 `q01`～`q15`。时间、版本和验证标签由服务端产生。客户端提交的分数不被使用，也不将 `quiz` 作为认证结果。

`expectedUserId` 不是认证凭证，仅用于阻止多个标签页切换账号令牌后把旧账号数据写入新账号。实际用户从服务端会话确定；不匹配时拒绝。

`revision` 是乐观并发控制。客户端必须提交最近读取的版本；成功后版本递增。旧版本返回 409，客户端重新读取 `/me` 后执行三方合并，再以最新版本提交，不直接重放旧快照。响应丢失时也先读取云端确认。

网页不提供手动同步、云端恢复或导出按钮。登录时把当前无归属游客进度自动合入账号，使用同一 `/progress` 同步流程；`/import` 保留兼容，但新界面不再调用。游客数据合入后归属当前账号，退出使用新的空白游客档案，避免已取消的收藏再次导入。到访和学习取并集；收藏仅把本地相对基线的新增与取消应用到最新远端；最近节点在本地改变时使用本地值。写请求期间的新修改继续留在本机等待下一轮同步。

## 主要失败状态

- 400：字段或 ID 不合法。
- 401：没有会话、会话过期、凭证错误。
- 403：写请求来源或客户端头错误，或账号已被管理员停用。
- 409：账号名冲突、账号切换、进度版本冲突。
- 413 / 415：请求超过 16 KiB / 非 JSON。
- 429：触发基础限流，Retry-After 为当前窗口剩余秒数。
- 503：密码派生并发上限、限流存储容量已满，或数据库暂时断连、连接拥塞、锁冲突；Retry-After 为建议等待秒数。不把表结构、权限或 SQL 错误伪装成临时故障。

`/live` 只确认已启动进程仍能响应，`/health` 会实际执行数据库查询。数据库故障时 `/health` 返回 503，`/live` 仍可返回 200；启动时数据库配置和表结构校验失败仍会阻止启动。不要用存活检查替代数据库就绪检查。

服务不会自动重放失败的数据库写操作；连接中断时事务可能已经提交。收到 503 或响应丢失后，进度写入先读取 `/me` 确认版本，再按原有合并规则同步；注册结果不确定时可尝试登录，不盲目反复注册。

## 数据与会话

MySQL InnoDB 表为 `users`、`sessions`、`progress`、`admin_sessions`、`admin_audit_events`，`schema_version` 当前为版本 2；连接采用 utf8mb4，进度数组使用 JSON 列。注册的用户、初始进度和会话在同一事务内创建，任何一步失败全部回滚；登录在事务中复核凭证、创建会话并读取进度。进度更新使用事务及版本条件避免并发覆盖。密码使用带独立随机盐的 scrypt，参数为 N=131072、r=8、p=1；派生最多同时运行两次。高熵会话令牌仅存 SHA-256 摘要，不存原文。会话有效期为七天，退出撤销当前会话。版本 1 数据库需先由具备 DDL 权限的账号执行 `npm run db:init` 升级；生产模式 `MYSQL_AUTO_INIT=false` 会拒绝版本 1，避免应用账号在冷启动时执行 DDL。

恢复码和 `/recover` 接口已移除，MySQL 不保存恢复码列。从 SQLite 迁移时保留账号、密码哈希与个人进度，不迁移旧会话及恢复码，用户需重新登录。迁移和备份恢复仅允许空目标数据库，操作前停止目标服务，详见 README。

服务不向用户提供管理能力：个人账号令牌不能访问任何管理接口。另有一套独立口令保护的账号管理接口（见下节），两者互不代签。没有把旧管理后台的口令写入配置或代码。

## 管理接口（`/api/account/admin`）

仅供站内数据看板的管理模块使用。口令与用户密码体系无关：`ADMIN_PASSWORD_HASH`（`scrypt$N$r$p$salt$key`，用 `server/security.mjs` 的 `hashPassword` 生成）与 `ADMIN_TOKEN_SECRET`（32 字节以上随机串）由部署环境提供，缺任一项时全部返回 503。`ADMIN_NAME` 是写入审计记录的操作者名称，默认 `admin`；共享同一个部署口令的人仍无法被区分。

| 方法 | 路径 | 请求体 | 结果 |
| --- | --- | --- | --- |
| POST | `/login` | `password` | `token, expiresAt, actor`（12 小时） |
| POST | `/logout` | `token` | 立即删除当前管理会话并记录审计 |
| POST | `/overview` | `token` | 注册总数、正常/停用账号数、近 7 天新增、有进度账号、完成节点/题目/印章数、会话数、最近写入 |
| POST | `/accounts` | `token, q, sort, order, page, size, hasProgress, session, status` | 账号列表；`status` 为 `active` 或 `disabled` |
| POST | `/account` | `token, username` | 单账号详情、账号状态和最近 10 条审计 |
| POST | `/sessions/revoke` | `token, username` | 删除该账号全部会话（不影响学习记录） |
| POST | `/accounts/status` | `token, username, status: active/disabled, reason` | 停用或恢复账号；停用同时撤销全部用户会话 |
| POST | `/audit` | `token, page, size, action?, result?` | 分页读取管理审计，不返回口令或令牌 |

约束：

- 响应里不出现 `id`、`password_hash`、`token_hash`；`sort` 只接受白名单键，`order` 只接受 asc/desc，`page/size` 夹取后以整数拼接。
- 令牌放请求体，不放 `Authorization`；写请求仍需 `Origin` 在 `ALLOWED_ORIGINS` 内且带 `X-SHW-Client: account-v1`。
- 管理令牌是 `expiresAt.nonce.HMAC`，其 SHA-256 摘要写入独立 `admin_sessions` 表；用户接口的会话校验看不到它，管理员退出后旧令牌立即失效。
- `admin_audit_events` 记录操作者、动作、对象、结果、简短原因和时间，不记录密码、用户令牌、管理令牌或数据库配置。登录失败、来源拒绝、会话撤销、账号停用/恢复和管理员退出都会记录。
- `sessions` 表没有创建时间，「最近登录」无法计算，因此不提供；列表中的「会话」只表示当前是否持有未过期会话。账号是否停用来自 `users.status`。
- 停用账号后，用户登录返回 403；已存在的用户会话在停用时全部删除。恢复正常后可以重新登录，原有到访、收藏和学习标记不变。

## 前端只读桥接（`account/cloud.js`）

`initializeAccount()` 会把只读快照挂到 `globalThis.__shwAccount`：

```js
{ version, getSnapshot(), subscribe(listener), open(), refresh() }
```

快照字段仅限用户可见信息：`authed / username / nickname / memberSince / available / syncing / message / panelReady / lastNode / updatedAt / endpoint`，不含用户 ID、令牌与进度版本。变更通过 `shw:account-changed` 事件通知，不派发 `shw:progress-updated`。

站内「我的山河」（`/profile`）依赖这段桥接；修改 `cloud.js` 时请保留该对象，否则页面只能读本地记录。
