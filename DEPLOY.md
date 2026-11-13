# YM 传文件 · 部署说明

> 部署使用站长自己的 Cloudflare 账号与 GitHub 仓库 YiMing918/ym-transfer。
> 全程免费：R2 免费 10GB、D1 免费、Pages 免费；不要在任何一步选付费项。

## 0. 先看预览

部署前先打开 `preview.html`（仓库根目录，`npm run preview` 生成）确认界面：布局、按钮、文字。确认没问题再动手部署。

## 1. 建 R2 存储桶（私有）

Cloudflare 后台 → R2 对象存储 → 创建存储桶：

- 名称：`ym-transfer-files`
- 位置：自动（默认）
- **不要**开启公开访问，也**不要**绑 r2.dev 公开域名（下载走预签名跳转，桶保持私有）。

建好后配 CORS（不配浏览器传不上去，会报 CORS 错）：

- 方法一（面板）：桶 → 设置 → CORS 策略 → 粘贴 `r2-cors.json` 的内容。
- 方法二（命令行）：`npx wrangler r2 bucket cors put ym-transfer-files --file r2-cors.json`（需先 `wrangler login` 或配好 API 令牌）。
- 以后加了自定义域名，要把新域名也加进 `AllowedOrigins`，否则新域名下上传会 CORS 报错。

## 2. 建 D1 数据库并建表

Cloudflare 后台 → D1 SQL 数据库 → 创建数据库：

- 名称：`ym-transfer-db`
- 记下数据库 ID（后面要用）。

建表（二选一，两个迁移文件都要跑，先 0001 再 0002）：

- 方法一（面板）：进数据库 → 控制台 → 先粘贴 `schema/0001_init.sql` 全文执行，再粘贴 `schema/0002_add_max_downloads.sql` 全文执行。
- 方法二（命令行）：`npx wrangler d1 execute ym-transfer-db --remote --file=schema/0001_init.sql`，再跑一次 `--file=schema/0002_add_max_downloads.sql`。
- 表结构用 `IF NOT EXISTS`，重复执行没事。**0002 是下载次数上限那列（max_downloads），不跑它，选了下载次数的上传会报错。**

## 3. 建 R2 的 S3 API 令牌（签发预签名 URL 用）

Cloudflare 后台 → R2 对象存储 → API 令牌 → 创建 API 令牌：

- 权限：**对象读写**（Object Read & Write），仅限 `ym-transfer-files` 这一个桶。
- 记下三样东西：**Access Key ID**、**Secret Access Key**、**账号 ID**。
- S3 端点是 `https://<账号ID>.r2.cloudflarestorage.com`。
- Secret Access Key 只显示一次，丢了要重新建。

## 4. GitHub 建仓库并推代码

- GitHub 上新建公开仓库 `YiMing918/ym-transfer`，不要勾选 README/.gitignore/license（仓库里已经有了）。
- 把本仓库代码推上去，默认分支 `main`：

```bash
git init
git add .
git commit -m "ym-transfer v1.0.0：传文件站（R2 直传 + D1 + 过期清理）"
git branch -M main
git remote add origin https://github.com/YiMing918/ym-transfer.git
git push -u origin main
```

## 5. Cloudflare Pages 建项目（连 GitHub）

Cloudflare 后台 → Workers 和 Pages → 创建 → Pages → 连接到 Git：

- 选仓库 `YiMing918/ym-transfer`，生产分支 `main`。
- 构建设置：**框架预设选 None**，**构建命令留空**（没有构建步骤），**构建输出目录填 `public`**。
- 关于 `wrangler.toml`：本仓库**不带**这份文件的真值版（只有 `wrangler.toml.example` 示例，没有任何账号/数据库标识）。绑定与变量一律在后台配（第 6 步）。注意：只要项目里出现带绑定段的 `wrangler.toml`，后台的绑定/变量编辑就会被锁定、改由文件管理，所以别把示例改名提交。
- 点「保存并部署」——第一次部署会失败或接口报错是正常的（Secret 还没配），先不管，继续第 6 步，配好后重新部署一次。

> **部署路径只走一条（重要）**：本站现行部署是第 8 步的 **deploy.yml 用 wrangler 直推**。项目如果是在这里「连接到 Git」建的，两条路会同时存在——推代码时 Git 集成自动部署一次、deploy.yml 又部署一次，互相覆盖且后到者赢，排障时极易误判。若已连 Git，请到 Pages 项目 → 设置 → 构建和部署里**断开 Git 集成**，只保留 deploy.yml 这一条路（反之只想用 Git 集成的人，则不要配第 8 步的部署 Secrets、删掉 deploy.yml）。

## 6. 绑定、变量与密钥（关键一步，别漏）

**后台配（本站现行方式）**：进 Pages 项目 → 设置 → 绑定 / 环境变量：

- **D1 数据库绑定**：变量名 `DB` → 选 `ym-transfer-db`。
- **R2 存储桶绑定**：变量名 `FILES` → 选 `ym-transfer-files`。
- 普通变量：`R2_S3_ENDPOINT` = `https://<你的账号ID>.r2.cloudflarestorage.com`（账号 ID 在 Cloudflare 后台首页右侧能看到）；`R2_S3_BUCKET` = `ym-transfer-files`。

（想改走文件路线的人：把 `wrangler.toml.example` 改名为 `wrangler.toml`、填上你自己的 `database_id` 与端点再提交——但那样后台编辑会被锁，且标识会进你的仓库，自行取舍。）

**密钥（都要配，且都不许写进任何仓库文件）**：

| 变量名 | 值 | 类型 |
|---|---|---|
| `R2_ACCESS_KEY_ID` | 第 3 步记下的 Access Key ID | **加密变量（Secret）** |
| `R2_SECRET_ACCESS_KEY` | 第 3 步记下的 Secret Access Key | **加密变量（Secret）** |
| `TASK_SECRET` | 自己编一个随机串（如 `openssl rand -hex 32` 的结果） | **加密变量（Secret）** |
| `IP_SALT` | 自己编一个随机串（可选，强烈建议配） | **加密变量（Secret）** |

`IP_SALT` 用于给访客 IP 做哈希加盐（限流计数用）：不配时代码里有一个公开的默认值兜底，功能不受影响，但盐公开等于没盐——拿到哈希的人可以离线反推 IP。配成只有你知道的随机串即可，不需要与任何其他地方一致。

这三枚密钥可以进 Pages 后台「设置 → 环境变量」手动加为加密变量；本站的做法是填进 GitHub Secrets（第 8 步），由 deploy 工作流自动推送到 Pages——改密钥后手动跑一次 deploy 工作流即可同步。`TASK_SECRET` 的值同时要填进 GitHub Secrets，两边必须一样。

配好后重新部署一次（部署 → 三个点 → 重新部署，或推一个空提交）。

## 7. （可选）R2 生命周期兜底

桶 → 设置 → 生命周期规则 → 加一条：**对象创建 10 天后删除**。作用是兜底：万一清理任务漏删，文件最晚 10 天也会被 R2 自己删掉（本站文件最长有效期是 7 天，10 天兜底不会误删有效文件）。

## 8. GitHub Secrets（两个工作流用）

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 值 | 用处 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | API 令牌（权限含 Pages 编辑与 D1 编辑，如「编辑 Cloudflare Workers」模板） | deploy.yml 部署用 |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID | deploy.yml 部署用 |
| `R2_ACCESS_KEY_ID` | 同第 6 步 | deploy.yml 推送 Pages Secret 用 |
| `R2_SECRET_ACCESS_KEY` | 同第 6 步 | deploy.yml 推送 Pages Secret 用 |
| `TASK_SECRET` | 同第 6 步（两边必须一样） | deploy.yml 与 cleanup.yml 用 |
| `SITE_URL` | `https://ym-transfer.pages.dev` | cleanup.yml 定时清理用 |

配好后，推一次代码就会自动跑 deploy.yml；也可以在 Actions 里手动跑 `deploy` 与 `cleanup` 验证。

## 9. 部署后自测（自己测完再交付）

在 `https://ym-transfer.pages.dev` 上逐项测，全部通过才算完：

1. 首页是中文，「站内已用」显示 `0 / 10 GB`。
2. 传一个小文件（如 1MB 图片）：进度条走完 → 出现下载链接 → 复制 → **无痕窗口**打开链接，能下载，文件名正确。
3. 传一个较大文件（如 200MB 视频）：上传正常，下载后比对大小一致。
4. 超限拒绝：用接口直接测——`curl -X POST https://ym-transfer.pages.dev/api/upload-init -H 'Content-Type: application/json' -d '{"name":"x","mime":"application/octet-stream","size":5368709121,"expires_hours":72}'` 应返回 400 `bad_size`。（不用真传 5GB 文件，接口校验就够了。）
5. 打开一个不存在的下载链接（如 `/d/00000000000000000000000000000000`），应看到中文「不存在」页。
6. Actions 里手动跑一次 `cleanup` 工作流，应成功（刚部署时 deleted 为 0）。
7. 检查 R2 桶里有上传的对象、D1 `files` 表里有对应行（状态 ready）。
8. 过期验证：D1 里把一个文件的 `expires_at` 改到过去，再打开它的下载链接，应 404「已过期」，且 R2 对象与 D1 记录被删掉（懒清理）。

## 10. 自定义域名（以后再加）

- Pages 项目 → 自定义域 → 添加域名（如 `file.example.com`，换成你自己的域名）→ 按提示在 DNS 加 CNAME。
- **加完域名后**，把新域名加进 R2 桶的 CORS `AllowedOrigins`（见第 1 步），否则新域名下上传会 CORS 报错。
- GitHub Secret `SITE_URL` 改成新域名，清理工作流才会调新地址。

## 常见问题

- **上传报 CORS 错**：先查 R2 桶的 CORS 配了没有、来源域名对不对（pages.dev 与自定义域名都要加）、方法里有没有 PUT、头里有没有 Content-Type。
- **upload-init 返回 500 sign_failed**：R2 的 S3 凭据没配或配错了，检查 Pages Secret 里的 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` 与 `R2_S3_ENDPOINT`。
- **upload-complete 返回 not_uploaded**：浏览器 PUT 没成功（看浏览器控制台的网络请求），常见是 CORS 或预签名 URL 过期（上传地址有效 6 小时）。
- **下载链接 404**：文件可能已过期被清理，或 complete 没成功（状态还是 pending）。
- **站内空间不足（413）**：已用满 10GB，等旧文件过期或手动跑一次 cleanup 工作流。
