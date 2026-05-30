# tg-bot-mailer

通过 Telegram bot 命令管理 **Cloudflare Email Routing** 路由规则。整个 bot 运行在 Cloudflare Workers 上，无需服务器、免费额度足够个人使用。

适合场景：你有一个托管在 Cloudflare 的域名并开启了 Email Routing，想随手用 Telegram 创建一次性邮箱地址（如 `applede@yourdomain.com`），转发到你的主邮箱或交给某个 Email Worker 处理。

## 功能

| 命令 | 说明 |
|------|------|
| `/add <name> <邮箱>` | 创建 `<name>@你的域名` 的规则，转发到指定邮箱 |
| `/add <name>` | 创建 `<name>@你的域名` 的规则，发送到配置的 Email Worker |
| `/list` | 列出所有路由规则及状态 |
| `/delete <name>` | 删除规则 |
| `/disable <name>` | 停用规则（保留，可恢复） |
| `/enable <name>` | 启用规则 |
| `/help` | 显示帮助 |

`/add` 会自动判断第二个参数：是合法邮箱就转发到该邮箱，否则发送到 Worker。`<name>` 可以只写前缀（如 `applede`），也可以写完整地址，程序只取 `@` 前面的部分。

```
/add applede you@gmail.com       →  applede@yourdomain.com 转发到 you@gmail.com
/add beu                         →  beu@yourdomain.com 发送到 Worker
/disable beu                     →  停用
/enable beu                      →  重新启用
/delete beu                      →  删除
```

## 工作原理

```
Telegram  ──webhook──▶  Cloudflare Worker  ──API──▶  Cloudflare Email Routing
```

Worker 接收 Telegram 的 webhook 推送，校验来源与权限后，调用 Cloudflare API 增删改邮件路由规则。

安全上做了两重校验：
1. **Webhook secret**：校验请求头 `X-Telegram-Bot-Api-Secret-Token`，防止他人伪造请求。
2. **用户白名单**：只有 `ALLOWED_USER_IDS` 里的 Telegram user id 能操作。

---

## 部署教程

### 前置条件

- 一个托管在 Cloudflare 的域名，并已开启 **Email Routing**（控制台 → 你的域名 → Email → Email Routing）。
- 已安装 [Node.js](https://nodejs.org/)（18+）。

### 1. 准备需要的信息

| 信息 | 怎么获取 |
|------|----------|
| **Telegram Bot Token** | 找 [@BotFather](https://t.me/BotFather) 发 `/newbot` 创建，得到形如 `123456:ABC-DEF...` 的 token |
| **你的 Telegram User ID** | 找 [@userinfobot](https://t.me/userinfobot) 发任意消息，它会回复你的数字 id |
| **域名的 Zone ID** | Cloudflare → 选中你的域名 → Overview 页右下角 |
| **Cloudflare API Token** | 见下方步骤 4 |
| **Webhook Secret** | 自己随机生成一串字符串，命令：`openssl rand -hex 16` |

### 2. 克隆并安装依赖

```bash
git clone <这个仓库地址>
cd tg-bot-mailer
npm install
```

### 3. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会弹出授权页，点同意即可。

> ⚠️ 如果报 `Authentication error [code: 10000]`，说明你的 shell 里设置了 `CLOUDFLARE_API_TOKEN` 之类的环境变量干扰了登录。先执行
> `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_EMAIL CLOUDFLARE_API_KEY` 再重新 `npx wrangler login`。

### 4. 创建 Cloudflare API Token

进入 [API Tokens 页面](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Custom token，授予以下权限（限定到你的域名所在 Zone）：

- `Zone` → `Email Routing Rules` → **Edit**
- `Zone` → `Zone` → **Read**

创建后复制这个 token，下一步要用。

### 5. 填写配置

```bash
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml` 里的 `[vars]`：

```toml
EMAIL_DOMAIN     = "yourdomain.com"   # 你的域名
WORKER_NAME      = "my-email-relay"   # 你的 Email Worker 名称（用 /add 不带邮箱时的目标）
ALLOWED_USER_IDS = "123456789"        # 你的 Telegram user id，多个用逗号隔开
EMAIL_ZONE_ID    = "你的-zone-id"
```

> `wrangler.toml` 已被 `.gitignore` 忽略，里面填你的真实信息不会被提交。模板是 `wrangler.toml.example`。

### 6. 部署 Worker

```bash
npm run deploy
```

记下输出的 Worker URL，形如 `https://tg-bot-mailer.<你的子域>.workers.dev`。

### 7. 设置密钥（Secrets）

这三个是敏感信息，用 secret 加密存储，**不写进任何文件**。逐条执行，按提示粘贴对应的值后回车：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN     # BotFather 给的 token
npx wrangler secret put TELEGRAM_SECRET_TOKEN  # 第 1 步自己生成的随机串
npx wrangler secret put EMAIL_API_TOKEN        # 第 4 步创建的 Cloudflare API token
```

### 8. 注册 Telegram Webhook

把 bot 和你的 Worker 关联起来。`TELEGRAM_SECRET_TOKEN` 必须和上一步设置的**完全一致**：

```bash
TELEGRAM_BOT_TOKEN='你的bot token' \
TELEGRAM_SECRET_TOKEN='你的webhook secret' \
WORKER_URL='https://tg-bot-mailer.<你的子域>.workers.dev' \
  npm run set-webhook
```

看到 `"ok": true` 和 `"Webhook was set"` 即成功。

### 9. 测试

在 Telegram 给你的 bot 发 `/help`，应当返回命令列表。再试 `/add test 你的邮箱@gmail.com`，然后到 Cloudflare 的「Email Routing → Routing rules」页面核对是否新增了规则。

---

## 注意事项

- **转发到邮箱**：目标邮箱必须已在 Cloudflare Email Routing 的 **Destination addresses** 中验证过，否则创建规则会失败。
- **发送到 Worker**：`WORKER_NAME` 指定的 Email Worker 必须已部署并启用。
- **catch-all 规则**：本 bot 不创建也不展示「匹配所有邮件」的兜底规则，避免误操作。

## 常见问题

**Bot 没反应？**
- `TELEGRAM_SECRET_TOKEN` 两处值不一致 → Worker 会返回 403。重新执行第 7、8 步保持一致。
- 你的 user id 不在 `ALLOWED_USER_IDS` 里 → bot 回复「⛔️ 没有权限」。

**实时看日志排查：**

```bash
npx wrangler tail
```

**修改配置后**（域名、白名单、Worker 名等）记得重新 `npm run deploy`。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入三个 secret 的值
npm run dev
```

`.dev.vars` 也在 `.gitignore` 中，不会被提交。

## 项目结构

```
.
├── src/index.ts            # Worker 主逻辑（命令处理 + Cloudflare API + Telegram）
├── scripts/set-webhook.mjs # 注册 / 删除 Telegram webhook
├── wrangler.toml.example   # 配置模板（复制为 wrangler.toml 后填写）
├── .dev.vars.example       # 本地开发 secret 模板
└── README.md
```

## License

MIT
