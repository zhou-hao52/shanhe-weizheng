# 账号服务后端交接说明

交接日期：2026-11-08  
对应功能文档：《山河为证新增模块功能描述技术文档（初稿）》  
代码来源：`zhou-hao52/shanhe-weizheng` 的 `main` 分支，交接基线 `f3cc845` 及其后的交接修复提交  
主要接收人：周昊（负责合并、部署与线上联调）

本文是执行交接单，不替代 `README.md`、`docs/account-api.md` 和 `docs/published-site.md`。功能范围仍以产品技术文档为准；本文说明当前实现、线上状态、部署步骤和剩余差距。

## 1. 交接结论

- 个人主页和账号管理前端已经发布到正式 Pages；账号、进度同步和管理接口源码已经进入 `main`。
- 线上 FC 仍是旧后端。2026-11-08 实测 `/api/account/admin/login` 返回“请先登录，或重新登录已过期的账号”，这是旧路由行为；新版本在未配置管理环境变量时应返回 503，配置后用错误口令应返回 401“管理口令不正确”。
- 因此当前正式网页中的“账号管理”后端不可用，不能把前端已经发布等同于后端已经交付。
- 本轮后端使用 MySQL 结构版本 2，新增账号状态、服务端管理会话和管理审计表。升级只增加字段和表，不清空现有账号、进度或会话；部署前需由具备 `ALTER` 权限的数据库管理员执行 `npm run db:init`。
- 交接包 `shanhe-account-service-20261107.zip` 是运行快照，不含 Git 历史；后续维护必须以仓库 `main` 为源码基线。包内管理接口与基线源码一致，但包含了本次验收发现并修复的下划线搜索问题之前的版本。

## 2. 交接物

| 项目 | 位置或值 | 说明 |
| --- | --- | --- |
| 源码仓库 | `https://github.com/zhou-hao52/shanhe-weizheng` | 以 `main` 为准 |
| 正式网页 | `https://zhou-hao52.github.io/shanhe-weizheng/` | GitHub Pages，从 `main` 根目录发布 |
| API 基址 | `https://shanhe-weizheng-tstogjaxab.cn-hangzhou.fcapp.run/api/account` | 阿里云 FC |
| 管理接口源码 | `server/admin.mjs` | 独立口令和独立签名令牌 |
| 管理接口契约 | `docs/account-api.md` | 请求体、响应、错误码和隐私约束 |
| 部署说明 | `docs/published-site.md`、`docs/fc-deployment.md` | 保留现有数据库、TLS 与来源白名单 |
| 部署包 | `dist/shanhe-fc.zip` | 执行 `npm run package:fc` 重新生成，上传到 FC |
| 数据库 | 现有 RDS MySQL | 保留数据，先执行版本 1 → 2 的增量结构升级 |

不得把数据库密码、`ADMIN_PASSWORD_HASH`、`ADMIN_TOKEN_SECRET`、用户令牌或备份文件提交到 Git。

## 3. 后端职责与现有接口

### 3.1 用户账号与同步

- `POST /api/account/register`
- `POST /api/account/login`
- `POST /api/account/logout`
- `GET /api/account/me`
- `PATCH /api/account/me`
- `PUT /api/account/progress`
- `POST /api/account/import`（兼容接口，新页面不再主动调用）
- `GET /api/account/live`：只表示进程存活，不查询数据库
- `GET /api/account/health`：执行数据库查询，数据库不可用时返回 503

用户会话是七天有效的 Bearer 令牌；密码使用 scrypt 加盐存储；进度写入使用版本校验和事务。前端自动同步到访、收藏、题目学习标记和最近节点，不提供手动同步按钮。

### 3.2 看板账号管理

以下接口只供站内数据看板使用，全部为 `POST`，令牌放在 JSON 请求体中，不使用用户 Bearer 令牌：

| 路径 | 用途 | 写操作 |
| --- | --- | --- |
| `/api/account/admin/login` | 管理口令换取 12 小时管理令牌 | 否 |
| `/api/account/admin/logout` | 立即撤销当前管理令牌并写入审计 | 是，仅管理会话 |
| `/api/account/admin/overview` | 注册数、近 7 天新增、进度统计、有效会话数 | 否 |
| `/api/account/admin/accounts` | 搜索、排序、状态/进度/会话筛选、分页 | 否 |
| `/api/account/admin/account` | 单账号详情、账号状态和最近审计 | 否 |
| `/api/account/admin/audit` | 分页读取持久化审计 | 否 |
| `/api/account/admin/sessions/revoke` | 使指定账号的全部现有会话失效 | 是，仅会话 |
| `/api/account/admin/accounts/status` | 停用或恢复账号，写入原因与审计 | 是 |

管理响应不得返回内部用户 ID、密码哈希、令牌摘要或数据库配置。结束会话不会删除该账号的到访、收藏、学习标记和最近节点；停用账号会撤销现有用户会话，但同样保留学习记录。

### 3.3 个人主页只读桥接

`account/cloud.js` 向站点页面暴露 `globalThis.__shwAccount`，包含 `getSnapshot`、`subscribe`、`open`、`refresh`，并通过 `shw:account-changed` 通知状态变化。快照只提供用户可见的登录、同步、昵称、创建时间和最近节点，不提供用户 ID、令牌或进度版本。

修改 `account/cloud.js` 时必须保留该桥接；删除后个人主页只能使用本机记录，无法可靠反映账号登录和云端同步状态。

## 4. 部署前准备

保留 FC 现有运行配置，只补充以下两项管理接口变量：

```dotenv
ADMIN_PASSWORD_HASH=scrypt$131072$8$1$<由程序生成的 salt>$<由程序生成的 key>
ADMIN_TOKEN_SECRET=<至少 32 字节的高熵随机串>
ADMIN_NAME=admin
```

- `ADMIN_PASSWORD_HASH` 必须使用 `server/security.mjs` 的 `hashPassword()` 生成，格式为 `scrypt$N$r$p$salt$key`；不要自行拼接，也不要保存管理口令明文。
- `ADMIN_TOKEN_SECRET` 可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成。修改该值会立即使所有已签发管理令牌失效。
- `ADMIN_NAME` 写入审计记录，默认 `admin`。它只能标识一个部署操作者名称，不能区分共用相同管理口令的多名人员。
- 两项必须同时配置；缺任一项时全部管理接口返回 503，不影响普通用户注册、登录和进度同步。
- 保留现有 `HOST`、`PORT`、`NODE_ENV`、`PUBLIC_ORIGIN`、`ALLOWED_ORIGINS`、MySQL 地址、TLS CA 和数据库密码。
- `ALLOWED_ORIGINS` 必须是完整 HTTPS origin，逗号分隔，不带路径和末尾斜线；不得使用 `*`。

可在可信终端使用以下方式生成口令哈希；输入口令时不会回显，生成的哈希可以粘贴到 FC，明文不要进入 Git、聊天记录或命令历史：

```sh
printf '管理口令: ' >&2
IFS= read -rs ADMIN_PASSWORD
ADMIN_PASSWORD="$ADMIN_PASSWORD" node --input-type=module -e \
  'import { hashPassword } from "./server/security.mjs"; console.log(await hashPassword(process.env.ADMIN_PASSWORD))'
unset ADMIN_PASSWORD
```

## 5. FC 发布步骤

1. 在 FC 控制台先确认当前版本可回滚，不修改数据库和表。
2. 使用具备 `ALTER` 权限的数据库管理账号执行 `npm run db:init`，确认 `schema_version` 为 2。该步骤不清空数据。
3. 从仓库 `main` 的交接修复版本重新执行 `npm run package:fc`，不要上传旧压缩包。
4. 将 `dist/shanhe-fc.zip` 上传到函数 `shanhe-weizheng`，使用 Node.js 24 运行环境和原启动方式。
5. 补充 `ADMIN_PASSWORD_HASH`、`ADMIN_TOKEN_SECRET`、`ADMIN_NAME`，其他环境变量保持不变。
6. 发布到 `LATEST`，等待函数更新完成。
7. 重新验证健康检查、用户登录同步和看板账号管理；不要只检查 ZIP 是否上传成功。

如果发布失败，切回上一个 FC 版本。不要删除 `sessions`、`progress` 或 `users`，新旧版本的数据结构兼容。

## 6. 线上验收

### 6.1 后端版本

- `GET /api/account/health` 返回 200，`database` 为 `mysql`。
- 使用错误管理口令访问管理登录，必须返回 401“管理口令不正确”；若仍返回“请先登录”，说明新后端尚未部署。
- 使用正确管理口令登录后，`overview` 返回真实账号统计，数据库故障时显示错误而不是伪造 0。

### 6.2 管理功能

- 普通用户令牌不能访问任何 `/api/account/admin/*` 接口。
- 账号列表支持按账号名、昵称搜索；包含下划线的账号名必须能正确搜索。
- 列表排序、分页、有进度筛选和在线会话筛选正常。
- 单个账号详情的进度与个人主页、用户接口一致，不出现密码、哈希、令牌或内部用户 ID。
- 执行“结束全部会话”后，该账号需重新登录，但到访、收藏和学习标记保持不变。
- 停用账号后，其现有会话立即失效且登录返回 403；恢复后可以重新登录，进度仍保留。
- 管理员退出后，旧管理令牌立即失效，不能继续读取账号数据。
- 登录、来源拒绝、管理员退出、会话撤销和账号停用/恢复均出现在审计接口中。
- 非白名单来源调用管理接口返回 403。

### 6.3 个人主页

- 账号 A 的昵称、到访、收藏、学习标记、最近节点和印章状态只显示 A 的数据。
- 刷新、退出重登、独立浏览器登录后数据一致；切换到账号 B 后不残留 A 的数据。
- 断网时明确显示“暂存本机”或失败状态，恢复网络后自动重试。
- 未登录、空记录、加载中、同步失败和登录失效均有明确状态，不白屏。

### 6.4 已完成的隔离验收

2026-11-08 使用隔离 MySQL 数据库和模拟管理环境变量验证通过：

- 未授权来源被拒绝；错误管理口令被拒绝；正确口令签发独立管理令牌。
- 概览、账号列表、账号详情可读取；响应不包含密码、哈希、令牌或内部用户 ID。
- 用户 Bearer 令牌不能冒充管理令牌。
- 包含下划线的账号名搜索正常。
- 版本 1 数据库可无损升级到版本 2；生产模式会拒绝未迁移旧库。
- 账号停用会撤销用户会话并阻止登录；恢复后可重新登录，学习记录仍完整存在。
- 管理员退出后旧令牌返回 401；审计包含来源拒绝、登录、退出、会话撤销和状态变更。
- 结束账号会话后用户接口返回 401，重新登录后学习记录仍完整存在。

这些结果证明源码路径可用，不代表线上 FC 已部署新包。

## 7. 与技术文档的差距

后端已经补齐持久化审计、服务端管理员退出、账号停用/恢复和账号状态字段。以下仍是剩余差距：

- **看板前端接入**：当前已发布的数据看板前端仍只使用会话撤销；状态筛选、停用/恢复、服务端退出和审计列表需要前端重新构建后调用新接口。后端接口已可用，不能仅凭现有页面判断新功能已展示。
- **管理员身份**：当前仍是一个共享管理口令；`ADMIN_NAME` 只能标记部署时约定的操作者名称，不能区分多名人员共用同一口令的情况。若需要真正的多人权限，应改为独立管理员账号。
- **账号删除、进度重置、批量操作**：未实现；技术文档将其列为需谨慎评估项，当前不应临时补做。
- **服务端判题**：题目学习标记仍由前端上报，服务端不判题；不是认证成绩。
- **服务端印章**：印章仍由前端根据学习标记计算和解锁，未改为后端授予。
- **多实例**：限流是进程内存实现，扩容前必须替换为分布式限流。
- **高并发生产压测**：尚未完成，公开规模化运营前需补齐。

后端已满足审计和账号状态的核心接口要求，但正式页面尚未接入这些新增操作。交付时应分别说明“后端已实现”和“看板前端已展示”，不能混为一谈。

## 8. 回滚与故障排查

| 状态 | 判断与处理 |
| --- | --- |
| 管理登录仍提示“请先登录” | FC 还是旧包，重新部署最新 `dist/shanhe-fc.zip` |
| 管理接口返回 503 | 检查两项管理环境变量是否同时配置且格式正确 |
| 启动提示数据库版本 2 | 由数据库管理员先执行 `npm run db:init`，不要用生产应用账号手工删表 |
| 用户写请求返回 403 | 检查请求来源是否在 `ALLOWED_ORIGINS`，并带 `X-SHW-Client: account-v1` |
| 健康检查 503 | 数据库连接或 schema 检查失败；先读日志，不直接删表 |
| 用户提示令牌过期 | 检查 FC 是否重启、会话是否被管理员结束或七天有效期已过 |
| 新前端白屏 | 检查 `account/bootstrap.js` 引用的 `assets/index-<hash>.js` 是否已发布 |

注意：任何故障处理都不得通过清空线上用户、留言或统计表来“恢复”。
