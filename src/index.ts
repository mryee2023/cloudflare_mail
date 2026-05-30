export interface Env {
  // secrets
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN: string;
  EMAIL_API_TOKEN: string;
  // vars
  EMAIL_DOMAIN: string;
  WORKER_NAME: string;
  ALLOWED_USER_IDS: string;
  EMAIL_ZONE_ID: string;
}

interface TgUpdate {
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number };
    text?: string;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("ok", { status: 200 });
    }

    // 1) 校验请求来自 Telegram（webhook secret）
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }

    let update: TgUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const msg = update.message;
    if (!msg?.text || !msg.from) {
      return new Response("ok", { status: 200 });
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // 2) 权限白名单
    const allowed = env.ALLOWED_USER_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(String(userId))) {
      await sendMessage(env, chatId, "⛔️ 你没有权限使用此 bot。");
      return new Response("ok", { status: 200 });
    }

    try {
      const reply = await handleCommand(env, msg.text.trim());
      await sendMessage(env, chatId, reply);
    } catch (err) {
      await sendMessage(env, chatId, `❌ 出错了：${(err as Error).message}`);
    }

    return new Response("ok", { status: 200 });
  },
};

async function handleCommand(env: Env, text: string): Promise<string> {
  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase(); // 去掉 /add@botname 形式

  switch (cmd) {
    case "/start":
    case "/help":
      return helpText(env);
    case "/add":
      return addRule(env, parts.slice(1));
    case "/list":
      return listRules(env);
    case "/delete":
      return deleteRule(env, parts.slice(1));
    case "/disable":
      return setRuleEnabled(env, parts.slice(1), false);
    case "/enable":
      return setRuleEnabled(env, parts.slice(1), true);
    default:
      return `未知命令：${cmd}\n\n${helpText(env)}`;
  }
}

function helpText(env: Env): string {
  return [
    "📮 邮件路由管理 bot",
    "",
    `域名：${env.EMAIL_DOMAIN}`,
    `Worker：${env.WORKER_NAME}`,
    "",
    "命令：",
    "• /add <name> <邮箱>  —— 转发到指定邮箱",
    "• /add <name>         —— 发送到 worker",
    "• /list               —— 列出所有规则",
    "• /delete <name>      —— 删除规则",
    "• /disable <name>     —— 停用规则",
    "• /enable <name>      —— 启用规则",
    "",
    "示例：",
    "/add applede you@gmail.com",
    "/add beu",
  ].join("\n");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// /add <name> [target]
async function addRule(env: Env, args: string[]): Promise<string> {
  const name = args[0];
  if (!name) return "用法：/add <name> [邮箱]";

  const localPart = name.replace(/@.*$/, ""); // 容错：用户带了 @domain 也只取前缀
  const address = `${localPart}@${env.EMAIL_DOMAIN}`;
  const target = args[1];

  let action: { type: string; value: string[] };
  let targetDesc: string;

  if (target && EMAIL_RE.test(target)) {
    action = { type: "forward", value: [target] };
    targetDesc = `转发到邮箱 ${target}`;
  } else {
    action = { type: "worker", value: [env.WORKER_NAME] };
    targetDesc = `发送到 worker ${env.WORKER_NAME}`;
  }

  const body = {
    name: address,
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [action],
  };

  await cfApi(env, "POST", "/email/routing/rules", body);
  return `✅ 已创建规则\n${address}\n${targetDesc}`;
}

async function listRules(env: Env): Promise<string> {
  const rules = await getAllRules(env);
  if (rules.length === 0) return "（没有路由规则）";

  const lines = rules.map((r) => {
    const to = r.matchers?.find((m) => m.field === "to")?.value ?? r.name ?? "?";
    const act = r.actions?.[0];
    let dest = "?";
    if (act?.type === "forward") dest = `→ ${(act.value || []).join(", ")}`;
    else if (act?.type === "worker") dest = `→ worker ${(act.value || []).join(", ")}`;
    else if (act?.type === "drop") dest = "→ 丢弃";
    const status = r.enabled ? "🟢" : "⚪️";
    return `${status} ${to} ${dest}`;
  });
  return [`共 ${rules.length} 条规则：`, "", ...lines].join("\n");
}

async function deleteRule(env: Env, args: string[]): Promise<string> {
  const name = args[0];
  if (!name) return "用法：/delete <name>";
  const rule = await findRuleByName(env, name);
  if (!rule) return `未找到匹配 “${name}” 的规则。`;

  await cfApi(env, "DELETE", `/email/routing/rules/${rule.id}`);
  return `🗑 已删除规则 ${ruleAddress(rule)}`;
}

async function setRuleEnabled(
  env: Env,
  args: string[],
  enabled: boolean
): Promise<string> {
  const cmd = enabled ? "/enable" : "/disable";
  const name = args[0];
  if (!name) return `用法：${cmd} <name>`;
  const rule = await findRuleByName(env, name);
  if (!rule) return `未找到匹配 “${name}” 的规则。`;

  if (rule.enabled === enabled) {
    return `规则 ${ruleAddress(rule)} 已经是${enabled ? "活跃" : "停用"}状态。`;
  }

  await cfApi(env, "PUT", `/email/routing/rules/${rule.id}`, {
    name: rule.name,
    enabled,
    matchers: rule.matchers,
    actions: rule.actions,
  });
  return enabled
    ? `🟢 已启用规则 ${ruleAddress(rule)}`
    : `⚪️ 已停用规则 ${ruleAddress(rule)}`;
}

// ---------- Cloudflare Email Routing 辅助 ----------

interface CfRule {
  id: string;
  name?: string;
  enabled?: boolean;
  matchers?: { type: string; field?: string; value?: string }[];
  actions?: { type: string; value?: string[] }[];
}

function ruleAddress(r: CfRule): string {
  return r.matchers?.find((m) => m.field === "to")?.value ?? r.name ?? r.id;
}

// 按 name 前缀或完整邮箱模糊匹配
async function findRuleByName(env: Env, name: string): Promise<CfRule | null> {
  const target = name.includes("@") ? name : `${name}@${env.EMAIL_DOMAIN}`;
  const rules = await getAllRules(env);
  return rules.find((r) => ruleAddress(r) === target) ?? null;
}

async function getAllRules(env: Env): Promise<CfRule[]> {
  const out: CfRule[] = [];
  let page = 1;
  // catch-all 规则也会返回，但我们只展示普通规则
  for (;;) {
    const res = await cfApi(
      env,
      "GET",
      `/email/routing/rules?page=${page}&per_page=50`
    );
    const result = (res.result as CfRule[]) || [];
    out.push(...result);
    const info = res.result_info as { total_count?: number } | undefined;
    if (!info?.total_count || out.length >= info.total_count || result.length === 0) {
      break;
    }
    page++;
  }
  // 过滤掉 catch_all（其 matcher type 为 "all"）
  return out.filter((r) => !r.matchers?.some((m) => m.type === "all"));
}

interface CfResponse {
  success: boolean;
  errors: { code: number; message: string }[];
  result: unknown;
  result_info?: unknown;
}

async function cfApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown
): Promise<CfResponse> {
  const url = `https://api.cloudflare.com/client/v4/zones/${env.EMAIL_ZONE_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as CfResponse;
  if (!data.success) {
    const msg = data.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || res.status;
    throw new Error(`Cloudflare API: ${msg}`);
  }
  return data;
}

// ---------- Telegram ----------

async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}
