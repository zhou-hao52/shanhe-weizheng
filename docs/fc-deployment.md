# 阿里云 FC + 云 MySQL：比赛演示部署

状态（2026-11-02）：已创建杭州 RDS MySQL 8.0 试用实例，FC 尚未发布，没有部署成功的公网地址。当前本地 MySQL 改造和 FC 文件需要一起发布，不能假定 GitHub 旧版本已经包含它们。

## 1. 架构与花费先确认

```text
手机 / 电脑
    ↓ 同一个 HTTPS 域名
函数计算 FC：静态网页 + Node.js 24 账号 API
    ↓ 同地域、同 VPC 的内网连接
云 MySQL：账号、会话、到访、收藏、学习标记

原 WorkBuddy 留言 / 统计 / 管理后台：保持原来的独立连接
```

FC 托管运行环境，不用自行维护虚拟机；不等于没有服务器，也不保证免费。先在控制台核实 FC 调用/计算/公网流量、镜像仓库、日志和数据库的计费与试用资格，设置费用提醒。数据库独立计费，不默认等同于按调用计费；不要为了比赛演示直接开高配或自动续费。

数据库选兼容 MySQL 8.0+ 的服务，并确认支持 InnoDB、JSON、事务、外键和 TLS。FC 与数据库放在同一地域、同一 VPC，选择可互通的交换机及安全组，数据库白名单仅允许必要的函数私网范围，不开放 `0.0.0.0/0`。无需给数据库长期开公网地址。

先不要释放或重装已经购买的轻量服务器，也不要改动 WorkBuddy 数据。

## 2. 先准备网页入口

整站和 `/api/account/*` 必须保持同源。不要只把 API 接到 GitHub Pages 上，也不要修改 Cookie 为跨站或关闭来源检查。

FC 默认 HTTP 触发器域名属于测试入口；官方文档说明 `aliyuncs.com` 默认域名响应会加 `Content-Disposition: attachment`，浏览器可能下载 HTML 而不是显示网页。不能把“生成默认调用地址”当成“比赛网页已经可分享”。

正式网页入口配置自定义域名、DNS、HTTPS 证书，并将所有路径转发到同一个函数，保留原路径与方法。若控制台提供其他网页预览入口，也要实测页面、Cookie 和 API，而不是假设可直接用。

中国内地接入的域名应先核实并满足阿里云的备案要求；短期演示不能假定自动豁免。没有可用域名时先停在本地验收与资源方案确认，不承诺免费公网链接。

`PUBLIC_ORIGIN` 填浏览器实际使用的 origin，例如 `https://your-domain.example`，不能带 `/shanhe-weizheng/` 或末尾斜线。网页入口是该 origin 下的 `/shanhe-weizheng/`。

## 3. 数据库初始化与权限

先建立独立数据库 `shanhe`，字符集 `utf8mb4`。不要使用已有业务库或 root 作为函数运行账号。

通过 DMS 等数据库管理入口，在新库中依次执行：

1. 建立版本表：

   ```sql
   CREATE TABLE IF NOT EXISTS schema_version (
     id TINYINT PRIMARY KEY,
     version INT NOT NULL
   ) ENGINE=InnoDB;
   ```

2. 执行本仓库 `server/schema.sql` 全部 SQL。
3. 完成后标记版本：

   ```sql
   INSERT IGNORE INTO schema_version (id, version) VALUES (1, 1);
   ```

也可以在有安全数据库连接的管理环境执行 `npm ci` 和 `npm run db:init`。该命令需要初始化账号具备目标库的 `SELECT, INSERT, CREATE, INDEX, REFERENCES` 权限，不清空现有记录；它不是数据库版本升级工具。初始化完成后，函数只配置业务账号，权限限制为目标库的 `SELECT, INSERT, UPDATE, DELETE`。

Navicat 只是数据库管理客户端，不负责运行网站，也不是多设备访问的前提。优先使用 DMS 或云厂商支持的安全私网连接方式。确需本机 Navicat 连接时，只临时允许本机公网 IP、启用 TLS 并验证证书，完成后撤销访问；不要把数据库开放给所有人。不要把数据库密码写入代码、截图或聊天。

`MYSQL_AUTO_INIT=false` 时，冷启动只检查版本与业务表，不执行 DDL；未初始化或缺表会拒绝启动。旧 SQLite 数据不会自动导入，确需保留时先备份，再按 README 在空目标库迁移，不在运行中的函数里执行恢复或迁移。

## 4. 打包整站 ZIP（当前使用方式）

本机安装 Node.js 24、npm 和 `zip`，在仓库根目录执行：

```sh
npm run package:fc
```

产物为 `dist/shanhe-fc.zip`。脚本从白名单复制静态站与后端，在临时目录通过锁文件安装生产依赖，再从根目录压缩，ZIP 内直接包含 `server/index.mjs`、`node_modules/` 和 `index.html`，没有额外的项目文件夹。不要把整个工作目录直接压缩上传。

打包不包含 `.env`、本机用户数据、备份或 Git 历史，并拒绝符号链接、私钥文件和平台原生扩展；当前 MySQL 驱动使用可跨平台的 JavaScript 依赖。密码只填云端环境变量或密钥配置，不放入 ZIP。重新打包会替换之前的 ZIP，不改变数据库。

### 可选：自定义容器

如果改选自定义容器，可使用现有 Dockerfile；此路径需要 Docker 和阿里云镜像仓库登录权限，当前不要求本机安装 Docker。

在本仓库根目录执行，所有 `<...>` 均需要替换成自己的信息：

```sh
docker login <镜像仓库域名>
docker build --platform linux/amd64 -t <镜像仓库域名>/<命名空间>/shanhe:fc-demo-1 .
docker push <镜像仓库域名>/<命名空间>/shanhe:fc-demo-1
```

Apple Silicon 也显式使用 `linux/amd64`。选 FC 能拉取的同地域 ACR 仓库，私有仓库按控制台配置镜像拉取角色及仓库访问权限。记录镜像摘要，后续发布新版本用新标签/摘要，不覆盖正在验收的版本。

镜像包含静态站、账号模块、后端和锁定依赖。构建白名单排除 `.env`、本机数据库、备份、Git 历史及私钥；不要通过构建参数注入数据库密码。镜像以非 root 的 `node` 用户运行，不要求在容器里安装 MySQL 或 Nginx。

## 5. 创建 FC Web 自定义运行时函数

控制台具体字段以所选地域/产品版本为准，配置目标如下：

| 项目 | 本项目配置 |
| --- | --- |
| 运行方式 | Web 函数，自定义运行时 Node.js 24 / Debian 12，上传整站 ZIP；可用版本以控制台为准 |
| 启动命令 | `node server/index.mjs` |
| 监听端口 | `9000`；`HOST=0.0.0.0` |
| 内存 | 建议先 1 GiB；密码哈希占用内存较大，不以最小规格盲试 |
| 单实例并发 | 先设 2，验收后再测容量 |
| 最大实例数 | 先设 1；不是预留实例数，不要求一直保有实例 |
| 请求超时 | 建议先 60 秒，实测冷启动和数据库连接 |
| 网络 | 与 RDS 同地域/同 VPC，放通必要的内网数据库连接 |
| 环境变量 | 参考 `deploy/fc/.env.example`，真实值只填控制台/密钥配置 |

环境变量重点：`NODE_ENV=production`、正确的 HTTPS `PUBLIC_ORIGIN`、RDS 内网域名、业务账号密码、`MYSQL_SSL=true`、`MYSQL_AUTO_INIT=false`、`MYSQL_CONNECTION_LIMIT=2`。数据库须已开启 TLS。需要供应商 CA 时通过安全文件挂载提供 `MYSQL_SSL_CA`，且保证非 root 用户可读，不能禁用证书校验来绕过失败。

建公网 HTTP 触发器，放行网站使用的 `GET, HEAD, POST, PUT, PATCH`；自定义域名路由覆盖全部路径，包括 `/api/account/*`，不能剥掉前缀。网站需要普通浏览器访问，不能要求所有访客持有云平台签名密钥。若使用触发器匿名访问，账号写入仍由本应用会话和来源校验保护，不能认为函数完全私有。

当前限流是进程内存级，函数重建会重置，最多 1 个实例也不构成持久全局限流；反向代理后直连 IP 配额可能被所有访客共享。公网发布前应在可信网关/WAF 等入口设置登录/注册与总请求限流，不信任浏览器自填的转发头。不要为绕过限流直接扩容或取消应用校验。

连接数按“并存实例数 × 每实例连接池上限”预算，并预留发布新旧实例重叠和管理工具的连接。不要把实例上限当成绝对的数据库连接保证。日志只保留必要诊断，不输出密码、Cookie 或完整环境变量。

## 6. 验收后才分享

1. 访问 `https://your-domain.example/api/account/health`，应返回 `code: 0`；该接口实际检查数据库。
2. 打开 `/shanhe-weizheng/`，确认 HTML 正常显示而非下载，所有静态资源和档案详情页可打开。
3. 注册测试账号（3～24 位字母/数字/下划线，密码 15～128 字符），收藏一个节点，等待“已自动同步”。
4. 手机使用移动网络访问同一 HTTPS 链接，登录同一账号，确认收藏/到访恢复；无需 Navicat、手动同步或两台设备同 Wi-Fi。
5. 在另一台设备修改收藏，前台等待约 15 秒或重新聚焦，确认自动更新；退出后登录另一个账号，确认数据隔离。
6. 在控制台重启/更新测试函数后，确认原账号仍可登录、记录仍在；停止函数运行不等于删除数据库。
7. 检查 Cookie 为 `HttpOnly; Secure; SameSite=Strict`，正常来源写入成功，错误来源写入被拒绝。
8. 不用线上留言、管理员清空或真实用户数据做验收；原 WorkBuddy 仍独立运行。

服务接收到 SIGTERM/SIGINT 后停止接收新请求、等待已有连接，最多 10 秒后退出；平台是否投递信号及生命周期配置要按所选运行模式实测。不要依赖退出时把内存数据写入临时磁盘。账号与进度直接存 MySQL，实例重建无需搬本机文件。

FC 临时磁盘不适合保存 `backups/`。启用云数据库备份，必要时在可信管理环境运行应用备份并安全另存；不要在 HTTP 请求中生成或公开下载包含密码哈希的备份。

回滚时切换回已验收函数版本（或镜像）及对应配置，继续连接同一个兼容数据库；不要删除数据库、重建表或用旧备份覆盖线上记录。本次仅增加可选部署方式，不更改业务表版本。

## 官方核对入口

- 自定义容器、镜像架构及监听端口：https://www.alibabacloud.com/help/en/functioncompute/user-guide/create-a-custom-container-function
- FC 通过 VPC 访问 RDS：https://www.alibabacloud.com/help/en/functioncompute/how-does-function-compute-access-rds-1
- HTTP 触发器及默认域名附件行为：https://www.alibabacloud.com/help/en/functioncompute/user-guide/http-triggers-overview

创建资源前再次核实当前控制台的可用地域、价格、免费额度、域名接入及权限要求。本说明不承诺产品试用资格，也不代表完成了公网部署。
