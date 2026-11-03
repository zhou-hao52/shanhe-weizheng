# 团队原站发布

使用团队原仓库 `zhou-hao52/shanhe-weizheng` 发布，不改变前端视觉或作品归属，也不需要个人仓库作为网页入口。

- 网页入口：`https://zhou-hao52.github.io/shanhe-weizheng/`
- Pages 来源：`main` 分支，根目录 `/`。将 `部署后端版` 的接入改动通过合并请求合入 `main` 后，等待 Pages 发布完成；只推送部署分支不会更新原站。
- 账号 API：`https://shanhe-weizheng-tstogjaxab.cn-hangzhou.fcapp.run`
- 账号及学习记录存储：现有 RDS MySQL，不能将数据库密码写入前端或 Git。

## 账号服务来源配置

前端 `account/config.js` 中的 `accountApi` 指向现有 FC 地址，`account/cloud.js` 使用 Bearer token 跨域访问。FC 必须允许团队原站来源；只发布静态网页不代表注册登录已经可用。

```dotenv
PUBLIC_ORIGIN=https://zhou-hao52.github.io
ALLOWED_ORIGINS=https://zhou-hao52.github.io
```

保留函数原有的 MySQL、TLS、监听端口和其他环境变量。不得将来源白名单改成 `*`。

如果 HTTP 触发器另行配置了 CORS，也需要允许原站来源，以及 `GET, POST, PUT, PATCH, OPTIONS` 方法和 `Content-Type, X-SHW-Client, Authorization` 请求头。应用本身已处理预检和来源检查；触发器配置不能与应用冲突。若已有其他合法来源，保留在 `ALLOWED_ORIGINS` 中并用逗号分隔。

## 验收

1. 在手机和电脑直接打开网页入口，确认首页、地图、历史详情、答题页面和静态资源正常。
2. 确认已发布的 `account/config.js` 包含 FC 地址。从原网页发起账号接口的预检，响应应含 `Access-Control-Allow-Origin: https://zhou-hao52.github.io`。
3. 在网页注册账号，收藏一站并等待自动同步。
4. 在另一台设备登录同一账号，确认收藏与到访恢复。
5. 检查 API 的 `/api/account/live`（进程存活）和 `/api/account/health`（数据库可用）均返回 200。数据库故障模拟只在隔离测试库执行，不在验收用 RDS 上停库。

FC 默认地址只作为 API 使用，不作为网页分享入口。`docs/fc-deployment.md` 中的同源容器部署是另一种部署方式，不是此 Pages 跨域发布方案。

## 本轮验证记录（2026-11-04）

- 隔离的本机 MySQL 9.4.0 上通过 10 组集成检查：健康检查与 CORS、注册与重复账号、多设备会话与进度冲突、账号隔离与输入验证、单设备退出、注册失败整体回滚、回滚失败保留原异常、停库后的安全 503、重启后的会话与记录持久化、限流等待时间与存活检查。
- 故障注入及停库仅针对临时测试库，不操作现有 RDS，不代表已在生产 MySQL 版本上执行相同测试。
- 线上只读检查：现有 `/api/account/health` 返回 200；新增 `/api/account/live` 返回 401，说明本轮新增存活接口尚未部署。原站接入 PR #1 仍未合并。
- `dist/shanhe-fc.zip` 已重新打包；将该包上传并发布 FC 时保留原有环境变量，之后重新检查 `/live`、`/health`、原站 CORS 和跨设备登录同步。Git 推送不等于 FC 已更新。
