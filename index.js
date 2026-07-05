/**
 * Cloudflare Tunnel 巡查监控面板
 * -------------------------------------------------
 * 功能：
 * 1. 密码登录的 Web 面板（单页面，内嵌 HTML/CSS/JS）
 * 2. 面板中可以填写：Cloudflare Account ID / API Token，
 *    以及每条 Tunnel 的 ID、名称、要触发的 GitHub 仓库/工作流
 * 3. 定时任务（Cron Trigger）巡查所有隧道状态，
 *    发现某条隧道从"正常"变为"异常"时，触发对应的 GitHub Actions 工作流
 * 4. 所有配置、状态、日志都存放在 KV 中
 */

const SESSION_COOKIE = "tm_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24小时

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return jsonResponse({ error: err.message || String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAllTunnels(env));
  },
};

// ------------------------- 路由 -------------------------

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 静态首页（登录 + 面板 合为一个页面，由前端 JS 判断状态）
  if (path === "/" && request.method === "GET") {
    return htmlResponse(renderPage());
  }

  if (path === "/api/login" && request.method === "POST") {
    return handleLogin(request, env);
  }

  if (path === "/api/logout" && request.method === "POST") {
    return handleLogout(request, env);
  }

  // 以下接口都需要登录态
  const authed = await isAuthed(request, env);

  if (path === "/api/session" && request.method === "GET") {
    return jsonResponse({ authed });
  }

  if (!authed) {
    return jsonResponse({ error: "未登录或登录已过期" }, 401);
  }

  if (path === "/api/config" && request.method === "GET") {
    const config = await getConfig(env);
    return jsonResponse({ config: maskConfig(config) });
  }

  if (path === "/api/config" && request.method === "POST") {
    const body = await request.json();
    await saveConfig(env, body);
    return jsonResponse({ ok: true });
  }

  if (path === "/api/status" && request.method === "GET") {
    const result = await getAllTunnelStatus(env);
    return jsonResponse({ tunnels: result });
  }

  if (path === "/api/check" && request.method === "POST") {
    await checkAllTunnels(env);
    return jsonResponse({ ok: true });
  }

  if (path === "/api/logs" && request.method === "GET") {
    const logs = await getLogs(env);
    return jsonResponse({ logs });
  }

  return jsonResponse({ error: "Not Found" }, 404);
}

// ------------------------- 登录 / 会话 -------------------------

async function handleLogin(request, env) {
  const { password } = await request.json();
  if (!env.DASHBOARD_PASSWORD) {
    return jsonResponse({ error: "服务端未设置 DASHBOARD_PASSWORD，请先用 wrangler secret put 设置" }, 500);
  }
  if (password !== env.DASHBOARD_PASSWORD) {
    return jsonResponse({ error: "密码错误" }, 401);
  }
  const token = crypto.randomUUID();
  await env.TUNNEL_KV.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL_SECONDS });

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Secure; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Strict`
  );
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleLogout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.TUNNEL_KV.delete(`session:${token}`);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function isAuthed(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const v = await env.TUNNEL_KV.get(`session:${token}`);
  return v === "1";
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ------------------------- 配置读写 -------------------------

const CONFIG_KEY = "config";

async function getConfig(env) {
  const raw = await env.TUNNEL_KV.get(CONFIG_KEY);
  if (!raw) {
    return { cfAccountId: "", cfApiToken: "", githubToken: "", tunnels: [] };
  }
  return JSON.parse(raw);
}

async function saveConfig(env, config) {
  // 简单校验结构
  const safeConfig = {
    cfAccountId: config.cfAccountId || "",
    cfApiToken: config.cfApiToken || "",
    githubToken: config.githubToken || "",
    tunnels: Array.isArray(config.tunnels) ? config.tunnels.map((t) => ({
      id: t.id || "",
      name: t.name || "",
      owner: t.owner || "",
      repo: t.repo || "",
      workflowFile: t.workflowFile || "",
      ref: t.ref || "main",
      githubToken: t.githubToken || "", // 可选，per-tunnel 覆盖全局 token
    })) : [],
  };
  await env.TUNNEL_KV.put(CONFIG_KEY, JSON.stringify(safeConfig));
}

// 返回给前端时，把敏感字段打码，避免明文回显在浏览器里
function maskConfig(config) {
  const mask = (s) => (s ? s.slice(0, 4) + "****" + s.slice(-2) : "");
  return {
    ...config,
    cfApiToken: config.cfApiToken,
    githubToken: config.githubToken,
    // 注意：这里为了方便编辑，实际把真实值也返回了（因为面板本身就是管理员在用）。
    // 如果你希望更安全，可以把上面两行改成 mask(config.cfApiToken) / mask(config.githubToken)
    // 但这样用户编辑时就需要重新输入完整 token。
  };
}

// ------------------------- 日志 -------------------------

const LOGS_KEY = "logs";
const MAX_LOGS = 100;

async function getLogs(env) {
  const raw = await env.TUNNEL_KV.get(LOGS_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function addLog(env, message) {
  const logs = await getLogs(env);
  logs.unshift({ time: new Date().toISOString(), message });
  await env.TUNNEL_KV.put(LOGS_KEY, JSON.stringify(logs.slice(0, MAX_LOGS)));
}

// ------------------------- Cloudflare Tunnel 状态查询 -------------------------

async function getTunnelStatus(accountId, apiToken, tunnelId) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error(
      "查询隧道状态失败: " + (data.errors ? JSON.stringify(data.errors) : resp.status)
    );
  }
  // status 取值一般为: healthy / degraded / down / inactive
  return data.result.status || "unknown";
}

async function getAllTunnelStatus(env) {
  const config = await getConfig(env);
  const results = [];
  for (const t of config.tunnels) {
    let status = "unknown";
    let error = null;
    try {
      status = await getTunnelStatus(config.cfAccountId, config.cfApiToken, t.id);
    } catch (e) {
      error = e.message;
    }
    results.push({ id: t.id, name: t.name, status, error });
  }
  return results;
}

// ------------------------- 巡查 + 触发 GitHub Actions -------------------------

async function checkAllTunnels(env) {
  const config = await getConfig(env);
  if (!config.cfAccountId || !config.cfApiToken || !config.tunnels.length) return;

  for (const t of config.tunnels) {
    const statusKey = `status:${t.id}`;
    let status = "unknown";
    try {
      status = await getTunnelStatus(config.cfAccountId, config.cfApiToken, t.id);
    } catch (e) {
      await addLog(env, `⚠️ 检查隧道 [${t.name || t.id}] 时出错: ${e.message}`);
      continue;
    }

    const prevStatus = await env.TUNNEL_KV.get(statusKey);
    const isDownNow = status !== "healthy";
    const wasDownBefore = prevStatus === "down";

    if (isDownNow && !wasDownBefore) {
      // 由正常变异常，触发一次 GitHub Actions
      try {
        await triggerGithubWorkflow(config, t);
        await addLog(env, `🔴 隧道 [${t.name || t.id}] 状态异常(${status})，已触发工作流 ${t.owner}/${t.repo} : ${t.workflowFile}`);
      } catch (e) {
        await addLog(env, `❌ 隧道 [${t.name || t.id}] 触发 GitHub 工作流失败: ${e.message}`);
      }
    } else if (!isDownNow && wasDownBefore) {
      await addLog(env, `🟢 隧道 [${t.name || t.id}] 已恢复正常`);
    }

    await env.TUNNEL_KV.put(statusKey, isDownNow ? "down" : "healthy");
  }
}

async function triggerGithubWorkflow(config, tunnel) {
  const token = tunnel.githubToken || config.githubToken;
  if (!token) throw new Error("未配置 GitHub Token");
  if (!tunnel.owner || !tunnel.repo || !tunnel.workflowFile) {
    throw new Error("该隧道未配置完整的 GitHub 仓库/工作流信息");
  }

  const url = `https://api.github.com/repos/${tunnel.owner}/${tunnel.repo}/actions/workflows/${tunnel.workflowFile}/dispatches`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tunnel-monitor-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: tunnel.ref || "main" }),
  });

  if (resp.status !== 204) {
    const text = await resp.text();
    throw new Error(`GitHub API 返回 ${resp.status}: ${text}`);
  }
}

// ------------------------- 工具函数 -------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ------------------------- 前端页面（内嵌） -------------------------

function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Tunnel 巡查监控面板</title>
<style>
  :root {
    --bg: #0f1115;
    --card: #171a21;
    --border: #262b36;
    --text: #e6e8eb;
    --muted: #8b93a3;
    --accent: #4f8cff;
    --green: #33c17a;
    --red: #ef5350;
    --yellow: #f2b84b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
  }
  .center-box {
    max-width: 380px; margin: 12vh auto; background: var(--card);
    border: 1px solid var(--border); border-radius: 12px; padding: 32px;
  }
  .center-box h1 { font-size: 18px; margin-bottom: 20px; text-align: center; }
  input {
    width: 100%; padding: 10px 12px; margin-bottom: 12px; border-radius: 8px;
    border: 1px solid var(--border); background: #0f1115; color: var(--text); font-size: 14px;
  }
  button {
    width: 100%; padding: 10px; border: none; border-radius: 8px; background: var(--accent);
    color: white; font-size: 14px; cursor: pointer;
  }
  button:hover { opacity: 0.9; }
  button.secondary { background: #2a2f3a; }
  button.danger { background: var(--red); }
  .error { color: var(--red); font-size: 13px; margin-bottom: 10px; }
  .container { max-width: 960px; margin: 30px auto; padding: 0 16px; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .topbar h1 { font-size: 20px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 15px; margin-top: 0; margin-bottom: 14px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); font-size: 13px; }
  th { color: var(--muted); font-weight: 500; }
  .badge { padding: 3px 10px; border-radius: 999px; font-size: 12px; display: inline-block; }
  .badge.healthy { background: rgba(51,193,122,0.15); color: var(--green); }
  .badge.down, .badge.inactive, .badge.degraded { background: rgba(239,83,80,0.15); color: var(--red); }
  .badge.unknown { background: rgba(242,184,75,0.15); color: var(--yellow); }
  .tunnel-row { display: grid; grid-template-columns: repeat(6, 1fr) auto; gap: 8px; margin-bottom: 8px; align-items: center; }
  .tunnel-row input { margin-bottom: 0; }
  .row-flex { display: flex; gap: 10px; }
  .row-flex > * { flex: 1; }
  .small-btn { width: auto; padding: 6px 12px; font-size: 12px; }
  .logs { max-height: 260px; overflow-y: auto; font-size: 12px; color: var(--muted); }
  .logs div { padding: 4px 0; border-bottom: 1px dashed var(--border); }
  .hint { font-size: 12px; color: var(--muted); margin-top: -6px; margin-bottom: 14px; }
</style>
</head>
<body>

<div id="login-view" class="center-box" style="display:none">
  <h1>🔒 隧道监控面板登录</h1>
  <div id="login-error" class="error"></div>
  <input id="password" type="password" placeholder="请输入密码" />
  <button onclick="doLogin()">登录</button>
</div>

<div id="dashboard-view" class="container" style="display:none">
  <div class="topbar">
    <h1>🛰️ Tunnel 巡查监控面板</h1>
    <button class="secondary small-btn" style="width:auto" onclick="doLogout()">退出登录</button>
  </div>

  <div class="card">
    <h2>隧道实时状态</h2>
    <table id="status-table">
      <thead><tr><th>名称</th><th>Tunnel ID</th><th>状态</th></tr></thead>
      <tbody id="status-body"></tbody>
    </table>
    <div style="margin-top:12px" class="row-flex">
      <button class="small-btn" style="width:auto" onclick="refreshStatus()">🔄 刷新状态</button>
      <button class="small-btn" style="width:auto" onclick="manualCheck()">⚡ 立即巡查一次</button>
    </div>
  </div>

  <div class="card">
    <h2>全局配置</h2>
    <div class="hint">Account ID / API Token 用于查询 Cloudflare Tunnel 状态；GitHub Token 作为触发工作流的默认凭证（每条隧道也可单独覆盖）</div>
    <input id="cfAccountId" placeholder="Cloudflare Account ID" />
    <input id="cfApiToken" placeholder="Cloudflare API Token (需要 Tunnel:Read 权限)" />
    <input id="githubToken" placeholder="GitHub Token（默认，Fine-grained PAT，需 workflow 权限）" />
  </div>

  <div class="card">
    <h2>隧道 & 对应 GitHub 工作流</h2>
    <div id="tunnel-list"></div>
    <button class="secondary small-btn" style="width:auto; margin-top:8px" onclick="addTunnelRow()">+ 添加隧道</button>
    <div style="margin-top:16px">
      <button onclick="saveConfig()">💾 保存配置</button>
    </div>
  </div>

  <div class="card">
    <h2>巡查日志</h2>
    <div id="logs" class="logs"></div>
  </div>
</div>

<script>
let tunnels = [];

async function checkSession() {
  const r = await fetch('/api/session');
  const d = await r.json();
  if (d.authed) {
    showDashboard();
  } else {
    document.getElementById('login-view').style.display = 'block';
  }
}

async function doLogin() {
  const password = document.getElementById('password').value;
  const r = await fetch('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
  const d = await r.json();
  if (r.ok) {
    document.getElementById('login-view').style.display = 'none';
    showDashboard();
  } else {
    document.getElementById('login-error').innerText = d.error || '登录失败';
  }
}

async function doLogout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

async function showDashboard() {
  document.getElementById('dashboard-view').style.display = 'block';
  await loadConfig();
  await refreshStatus();
  await loadLogs();
}

async function loadConfig() {
  const r = await fetch('/api/config');
  const d = await r.json();
  const c = d.config;
  document.getElementById('cfAccountId').value = c.cfAccountId || '';
  document.getElementById('cfApiToken').value = c.cfApiToken || '';
  document.getElementById('githubToken').value = c.githubToken || '';
  tunnels = c.tunnels || [];
  renderTunnelRows();
}

function renderTunnelRows() {
  const container = document.getElementById('tunnel-list');
  container.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'tunnel-row';
  header.innerHTML = '<div style="color:var(--muted);font-size:12px">名称</div><div style="color:var(--muted);font-size:12px">Tunnel ID</div><div style="color:var(--muted);font-size:12px">GitHub Owner</div><div style="color:var(--muted);font-size:12px">Repo</div><div style="color:var(--muted);font-size:12px">Workflow文件</div><div style="color:var(--muted);font-size:12px">分支(ref)</div><div></div>';
  container.appendChild(header);

  tunnels.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'tunnel-row';
    row.innerHTML = \`
      <input value="\${t.name||''}" onchange="tunnels[\${i}].name=this.value" placeholder="如: 隧道A" />
      <input value="\${t.id||''}" onchange="tunnels[\${i}].id=this.value" placeholder="Tunnel ID" />
      <input value="\${t.owner||''}" onchange="tunnels[\${i}].owner=this.value" placeholder="github用户/组织" />
      <input value="\${t.repo||''}" onchange="tunnels[\${i}].repo=this.value" placeholder="仓库名" />
      <input value="\${t.workflowFile||''}" onchange="tunnels[\${i}].workflowFile=this.value" placeholder="deploy.yml" />
      <input value="\${t.ref||'main'}" onchange="tunnels[\${i}].ref=this.value" placeholder="main" />
      <button class="danger small-btn" style="width:auto" onclick="removeTunnelRow(\${i})">删除</button>
    \`;
    container.appendChild(row);
  });
}

function addTunnelRow() {
  tunnels.push({ name: '', id: '', owner: '', repo: '', workflowFile: '', ref: 'main', githubToken: '' });
  renderTunnelRows();
}

function removeTunnelRow(i) {
  tunnels.splice(i, 1);
  renderTunnelRows();
}

async function saveConfig() {
  const config = {
    cfAccountId: document.getElementById('cfAccountId').value,
    cfApiToken: document.getElementById('cfApiToken').value,
    githubToken: document.getElementById('githubToken').value,
    tunnels,
  };
  const r = await fetch('/api/config', { method: 'POST', body: JSON.stringify(config) });
  if (r.ok) {
    alert('保存成功');
    await refreshStatus();
  } else {
    alert('保存失败');
  }
}

async function refreshStatus() {
  const r = await fetch('/api/status');
  const d = await r.json();
  const body = document.getElementById('status-body');
  body.innerHTML = '';
  (d.tunnels || []).forEach(t => {
    const tr = document.createElement('tr');
    const badgeClass = t.status || 'unknown';
    tr.innerHTML = \`<td>\${t.name || '(未命名)'}</td><td>\${t.id}</td><td><span class="badge \${badgeClass}">\${t.error ? '查询出错' : t.status}</span></td>\`;
    body.appendChild(tr);
  });
}

async function manualCheck() {
  await fetch('/api/check', { method: 'POST' });
  await refreshStatus();
  await loadLogs();
}

async function loadLogs() {
  const r = await fetch('/api/logs');
  const d = await r.json();
  const el = document.getElementById('logs');
  el.innerHTML = (d.logs || []).map(l => \`<div>[\${new Date(l.time).toLocaleString()}] \${l.message}</div>\`).join('') || '<div>暂无日志</div>';
}

checkSession();
</script>
</body>
</html>`;
}
