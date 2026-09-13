import type { Subscriber } from "./types";

export interface DashboardRoute {
  routeId: string;
  publicPath: string;
  subscribers: Subscriber[];
}

export interface DashboardStatus {
  ok: true;
  secretConfigured: boolean;
  generatedAt: string;
  routeCount: number;
  subscriberCount: number;
  routes: DashboardRoute[];
}

export function dashboardStatus(
  secretConfigured: boolean,
  routes: DashboardRoute[]
): DashboardStatus {
  const active = routes.filter((route) => route.subscribers.length > 0);
  return {
    ok: true,
    secretConfigured,
    generatedAt: new Date().toISOString(),
    routeCount: active.length,
    subscriberCount: active.reduce((sum, route) => sum + route.subscribers.length, 0),
    routes: active
  };
}

export function dashboardHtml(status: DashboardStatus): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dev router dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1419;
      --panel: #1a222c;
      --line: #2c3846;
      --text: #e8eef4;
      --muted: #8b9bb0;
      --ok: #3dd68c;
      --warn: #f5c542;
      --accent: #6cb6ff;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f4f6f8;
        --panel: #ffffff;
        --line: #d7dee6;
        --text: #15202b;
        --muted: #5c6b7a;
        --ok: #0f8a4b;
        --warn: #9a6b00;
        --accent: #0b6bcb;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 1.5rem; font-weight: 650; margin: 0 0 8px; }
    .lede { color: var(--muted); margin: 0 0 24px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 16px;
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .value { font-size: 1.25rem; font-weight: 650; margin-top: 6px; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .route { margin-bottom: 16px; }
    .route h2 { font-size: 0.95rem; margin: 0 0 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .empty { color: var(--muted); padding: 24px; text-align: center; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 20px; }
  </style>
</head>
<body>
  <main>
    <h1>Dev router</h1>
    <p class="lede">Worker health and live subscriber connections. This page is public.</p>
    <div class="stats">
      <div class="card">
        <div class="label">Worker</div>
        <div class="value ok">Healthy</div>
      </div>
      <div class="card">
        <div class="label">Management secret</div>
        <div class="value ${status.secretConfigured ? "ok" : "warn"}">${status.secretConfigured ? "Configured" : "Missing"}</div>
      </div>
      <div class="card">
        <div class="label">Active routes</div>
        <div class="value">${status.routeCount}</div>
      </div>
      <div class="card">
        <div class="label">Connections</div>
        <div class="value">${status.subscriberCount}</div>
      </div>
    </div>
    <div id="routes">${renderRoutes(status.routes)}</div>
    <p class="meta">Updated <span id="updated">${escapeHtml(status.generatedAt)}</span> · auto-refresh 5s</p>
  </main>
  <script>
    const status = ${JSON.stringify(status)};
    function fmt(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
    }
    function render(data) {
      document.querySelector(".stats").innerHTML = \`
        <div class="card"><div class="label">Worker</div><div class="value ok">Healthy</div></div>
        <div class="card"><div class="label">Management secret</div><div class="value \${data.secretConfigured ? "ok" : "warn"}">\${data.secretConfigured ? "Configured" : "Missing"}</div></div>
        <div class="card"><div class="label">Active routes</div><div class="value">\${data.routeCount}</div></div>
        <div class="card"><div class="label">Connections</div><div class="value">\${data.subscriberCount}</div></div>\`;
      document.getElementById("routes").innerHTML = routesHtml(data.routes);
      document.getElementById("updated").textContent = fmt(data.generatedAt);
    }
    function routesHtml(routes) {
      if (!routes.length) {
        return '<div class="card empty">No active connections.</div>';
      }
      return routes.map((route) => {
        const rows = route.subscribers.map((sub) => \`
          <tr>
            <td><code>\${esc(sub.id)}</code></td>
            <td>\${esc(sub.transport || "public")}</td>
            <td><code>\${esc(sub.targetBaseUrl)}</code></td>
            <td>\${fmt(sub.lastHeartbeatAt)}</td>
            <td>\${fmt(sub.expiresAt)}</td>
          </tr>\`).join("");
        return \`<div class="card route"><h2>\${esc(route.publicPath)}</h2>
          <table><thead><tr><th>Subscriber</th><th>Transport</th><th>Target</th><th>Last heartbeat</th><th>Expires</th></tr></thead>
          <tbody>\${rows}</tbody></table></div>\`;
      }).join("");
    }
    function esc(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }
    render(status);
    async function refresh() {
      try {
        const res = await fetch("/dashboard.json", { cache: "no-store" });
        if (res.ok) render(await res.json());
      } catch {}
    }
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

function renderRoutes(routes: DashboardRoute[]): string {
  if (routes.length === 0) {
    return '<div class="card empty">No active connections.</div>';
  }
  return routes
    .map((route) => {
      const rows = route.subscribers
        .map(
          (sub) => `<tr>
            <td><code>${escapeHtml(sub.id)}</code></td>
            <td>${escapeHtml(sub.transport)}</td>
            <td><code>${escapeHtml(sub.targetBaseUrl)}</code></td>
            <td>${escapeHtml(new Date(sub.lastHeartbeatAt).toISOString())}</td>
            <td>${escapeHtml(new Date(sub.expiresAt).toISOString())}</td>
          </tr>`
        )
        .join("");
      return `<div class="card route"><h2>${escapeHtml(route.publicPath)}</h2>
        <table><thead><tr><th>Subscriber</th><th>Transport</th><th>Target</th><th>Last heartbeat</th><th>Expires</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
