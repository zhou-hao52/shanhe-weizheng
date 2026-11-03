# 独立仓库发布

此副本使用 `hao2530/shanhe-weizheng` 独立发布，不修改原仓库的 Pages 设置或前端视觉。

- 网页入口：`https://hao2530.github.io/shanhe-weizheng/`
- Pages 来源：`部署后端版` 分支，根目录 `/`。
- 账号 API：`https://shanhe-weizheng-tstogjaxab.cn-hangzhou.fcapp.run`
- 账号及学习记录存储：现有 RDS MySQL，不能将数据库密码写入前端或 Git。

## 账号服务来源配置

新网页与原网页的 origin 不同。必须在现有 FC 函数环境变量中加入新来源，并保存部署；只发布静态网页不代表注册登录已经可用。

```dotenv
PUBLIC_ORIGIN=https://hao2530.github.io
ALLOWED_ORIGINS=https://hao2530.github.io,https://zhou-hao52.github.io
```

保留函数原有的 MySQL、TLS、监听端口和其他环境变量。不得将来源白名单改成 `*`。

如果 HTTP 触发器另行配置了 CORS，也需要允许新来源，以及 `GET, POST, PUT, PATCH, OPTIONS` 方法和 `Content-Type, X-SHW-Client, Authorization` 请求头。应用本身已处理预检和来源检查；触发器配置不能与应用冲突。

## 验收

1. 在手机和电脑直接打开网页入口，确认首页、地图、历史详情、答题页面和静态资源正常。
2. 从新网页发起账号接口的预检，响应应含 `Access-Control-Allow-Origin: https://hao2530.github.io`。
3. 在网页注册账号，收藏一站并等待自动同步。
4. 在另一台设备登录同一账号，确认收藏与到访恢复。

FC 默认地址只作为 API 使用，不作为网页分享入口。`docs/fc-deployment.md` 中的同源容器部署是另一种部署方式，不是此 Pages 跨域发布方案。
