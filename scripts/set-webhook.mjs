// 注册 / 删除 Telegram webhook
//
// 用法：
//   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_SECRET_TOKEN=yyy WORKER_URL=https://tg-bot-mailer.xxx.workers.dev \
//     node scripts/set-webhook.mjs
//   node scripts/set-webhook.mjs --delete

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_SECRET_TOKEN;
const url = process.env.WORKER_URL;
const isDelete = process.argv.includes("--delete");

if (!token) {
  console.error("缺少 TELEGRAM_BOT_TOKEN 环境变量");
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

if (isDelete) {
  const res = await api("deleteWebhook", { drop_pending_updates: true });
  console.log(JSON.stringify(res, null, 2));
} else {
  if (!url || !secret) {
    console.error("缺少 WORKER_URL 或 TELEGRAM_SECRET_TOKEN 环境变量");
    process.exit(1);
  }
  const res = await api("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message"],
  });
  console.log(JSON.stringify(res, null, 2));
  const info = await api("getWebhookInfo", {});
  console.log(JSON.stringify(info, null, 2));
}
