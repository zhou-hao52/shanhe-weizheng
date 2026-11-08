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
- 本次交接不需要修改 MySQL 表结构，不需要迁移现有账号、进度或会话数据。
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
| 数据库 | 现有 RDS MySQL | 不更换、不清空、不执行表结构迁移 |

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
| `/api/account/admin/overview` | 注册数、近 7 天新增、进度统计、有效会话数 | 否 |
| `/api/account/admin/accounts` | 搜索、排序、筛选、分页账号列表 | 否 |
| `/api/account/admin/account` | 单账号只读详情 | 否 |
| `/api/account/admin/sessions/revoke` | 使指定账号的全部现有会话失效 | 是，仅会话 |

管理响应不得返回内部用户 ID、密码哈希、令牌摘要或数据库配置。结束会话不会删除该账号的到访、收藏、学习标记和最近节点。

### 3.3 个人主页只读桥接

`account/cloud.js` 向站点页面暴露 `globalThis.__shwAccount`，包含 `getSnapshot`、`subscribe`、`open`、`refresh`，并通过 `shw:account-changed` 通知状态变化。快照只提供用户可见的登录、同步、昵称、创建时间和最近节点，不提供用户 ID、令牌或进度版本。

修改 `account/cloud.js` 时必须保留该桥接；删除后个人主页只能使用本机记录，无法可靠反映账号登录和云端同步状态。

## 4. 部署前准备

保留 FC 现有运行配置，只补充以下两项管理接口变量：

```dotenv
ADMIN_PASSWORD_HASH=scrypt$131072$8$1$<由程序生成的 salt>$<由程序生成的 key>
ADMIN_TOKEN_SECRET=<至少 32 字节的高熵随机串>
```

- `ADMIN_PASSWORD_HASH` 必须使用 `server/security.mjs` 的 `hashPassword()` 生成，格式为 `scrypt$N$r$p$salt$key`；不要自行拼接，也不要保存管理口令明文。
- `ADMIN_TOKEN_SECRET` 可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成。修改该值会立即使所有已签发管理令牌失效。
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
2. 从仓库 `main` 的交接修复版本重新执行 `npm run package:fc`，不要上传旧压缩包。
3. 将 `dist/shanhe-fc.zip` 上传到函数 `shanhe-weizheng`，使用 Node.js 24 运行环境和原启动方式。
4. 补充 `ADMIN_PASSWORD_HASH`、`ADMIN_TOKEN_SECRET`，其他环境变量保持不变。
5. 发布到 `LATEST`，等待函数更新完成。
6. 重新验证健康检查、用户登录同步和看板账号管理；不要只检查 ZIP 是否上传成功。

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
- 结束账号会话后用户接口返回 401，重新登录后学习记录仍完整存在。

这些结果证明源码路径可用，不代表线上 FC 已部署新包。

## 7. 与技术文档的差距

以下项目当前未实现，不能用“已有账号服务”替代说明：

- **审计**：目前只有单实例控制台日志，记录请求路径和耗时；没有持久化审计表，也没有可识别的操作者身份、动作对象和结果。技术文档要求管理员登录、退出、拒绝和重要维护操作可审计。
- **管理员身份**：当前是一个共享管理口令，不是多管理员账号；无法区分具体操作者。令牌无服务端撤销列表，只能等待过期或轮换密钥。
- **管理员退出**：没有服务端退出接口，前端删除令牌即退出。
- **账号状态**：没有“正常 / 停用 / 需重新登录”状态字段，也不支持暂停或恢复登录；只能结束现有会话。`sessions` 没有创建时间，因此不能提供“最近登录”。
- **账号删除、进度重置、批量操作**：未实现；技术文档将其列为需谨慎评估项，当前不应临时补做。
- **服务端判题**：题目学习标记仍由前端上报，服务端不判题；不是认证成绩。
- **服务端印章**：印章仍由前端根据学习标记计算和解锁，未改为后端授予。
- **多实例**：限流是进程内存实现，扩容前必须替换为分布式限流。
- **完整审计与高并发生产压测**：尚未完成，公开规模化运营前需补齐。

如果比赛版本必须满足技术文档的审计和账号状态要求，应由后端继续开发并经单独验收；如果不纳入本轮比赛范围，应在交付说明中明确标记为“未实现”，不能宣称已满足全部验收项。

## 8. 回滚与故障排查

| 状态 | 判断与处理 |
| --- | --- |
| 管理登录仍提示“请先登录” | FC 还是旧包，重新部署最新 `dist/shanhe-fc.zip` |
| 管理接口返回 503 | 检查两项管理环境变量是否同时配置且格式正确 |
| 用户写请求返回 403 | 检查请求来源是否在 `ALLOWED_ORIGINS`，并带 `X-SHW-Client: account-v1` |
| 健康检查 503 | 数据库连接或 schema 检查失败；先读日志，不直接删表 |
| 用户提示令牌过期 | 检查 FC 是否重启、会话是否被管理员结束或七天有效期已过 |
| 新前端白屏 | 检查 `account/bootstrap.js` 引用的 `assets/index-<hash>.js` 是否已发布 |

注意：任何故障处理都不得通过清空线上用户、留言或统计表来“恢复”。
