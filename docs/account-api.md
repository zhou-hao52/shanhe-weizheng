# 个人账号 API v1

此文档描述新增服务，不替代原 WorkBuddy 接口。前缀为 `/api/account`，仅允许同源网页调用。认证使用 HttpOnly、SameSite=Strict Cookie；生产 HTTPS 时增加 Secure。

写请求需 `Content-Type: application/json`、`X-SHW-Client: account-v1`，且 `Origin` 等于服务配置 `PUBLIC_ORIGIN`。不开放跨域 CORS；不接受前端传入的任意用户 ID 作为身份。

返回格式：成功 `{"code":0,"data":{...}}`，失败 `{"code":HTTP状态码,"message":"说明"}`。个人数据响应禁止缓存。

## 路由

| 方法 | 路径 | 请求体 | 结果 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | 服务及数据库健康信息 |
| POST | `/register` | `username, password, nickname?` | 创建账号和会话，返回 `user, progress` |
| POST | `/login` | `username, password` | 设置会话 Cookie，返回 `user, progress` |
| POST | `/logout` | `{}` | 撤销当前会话并清除 Cookie |
| GET | `/me` | 无 | 当前用户与个人进度 |
| PATCH | `/me` | `expectedUserId, nickname` | 更新昵称，返回用户与进度 |
| PUT | `/progress` | `expectedUserId, revision, progress` | 按版本保存，返回新进度 |
| POST | `/import` | `expectedUserId, revision, confirmed: true, progress` | 合并游客数组，保留云端已有最近节点；返回新进度 |

`username` 为 3～24 位 ASCII 字母、数字或下划线，统一转小写。密码至少 15 个字符、最多 128 个 UTF-16 代码单元；昵称为 1～24 个 Unicode 码点。注册后直接登录并自动同步，不提供自助找回密码功能。

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

`expectedUserId` 不是认证凭证，仅用于阻止多个标签页切换 Cookie 后把旧账号数据写入新账号。实际用户从服务端会话确定；不匹配时拒绝。

`revision` 是乐观并发控制。客户端必须提交最近读取的版本；成功后版本递增。旧版本返回 409，客户端重新读取 `/me` 后执行三方合并，再以最新版本提交，不直接重放旧快照。响应丢失时也先读取云端确认。

网页不提供手动同步、云端恢复或导出按钮。登录时把当前无归属游客进度自动合入账号，使用同一 `/progress` 同步流程；`/import` 保留兼容，但新界面不再调用。游客数据合入后归属当前账号，退出使用新的空白游客档案，避免已取消的收藏再次导入。到访和学习取并集；收藏仅把本地相对基线的新增与取消应用到最新远端；最近节点在本地改变时使用本地值。写请求期间的新修改继续留在本机等待下一轮同步。

## 主要失败状态

- 400：字段或 ID 不合法。
- 401：没有会话、会话过期、凭证错误。
- 403：写请求来源或客户端头错误。
- 409：账号名冲突、账号切换、进度版本冲突。
- 413 / 415：请求超过 16 KiB / 非 JSON。
- 429：触发基础限流。
- 503：密码派生并发上限或限流存储容量已满。

## 数据与会话

MySQL InnoDB 表为 `users`、`sessions`、`progress`，`schema_version` 记录结构版本；连接采用 utf8mb4，进度数组使用 JSON 列。注册和进度更新使用事务，进度通过版本条件更新避免并发覆盖。密码使用带独立随机盐的 scrypt，参数为 N=131072、r=8、p=1；派生最多同时运行两次。高熵会话令牌仅存 SHA-256 摘要，不存原文。会话有效期为七天，退出撤销当前会话。

恢复码和 `/recover` 接口已移除，MySQL 不保存恢复码列。从 SQLite 迁移时保留账号、密码哈希与个人进度，不迁移旧会话及恢复码，用户需重新登录。迁移和备份恢复仅允许空目标数据库，操作前停止目标服务，详见 README。

服务不实现 `/api/admin/*`，个人账号不能作为旧管理后台令牌。没有把之前提供的管理员口令写入配置或代码。
