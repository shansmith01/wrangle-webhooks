import type { Subscriber } from "./dev-router-types";
import type { ConnectionLogEvent } from "./connection-log";
import { publicPathForRouteId } from "./connection-log";
import {
  formatInboundBodyBytes,
  type InboundLogEvent
} from "./inbound-log";
import type { OAuthCallbackPathRow } from "./oauth-callback-path";

/** HTML dashboard snapshot of active routes and subscribers. */
export interface DashboardRoute {
  routeId: string;
  publicPath: string;
  subscribers: Subscriber[];
}

/** JSON status payload for `/dashboard/status`. */
export interface DashboardStatus {
  ok: true;
  secretConfigured: boolean;
  generatedAt: string;
  routeCount: number;
  subscriberCount: number;
  routes: DashboardRoute[];
  oauthCallbackPaths: OAuthCallbackPathRow[];
  inboundLog: InboundLogEvent[];
  connectionLog: ConnectionLogEvent[];
}

/** Build the dashboard status JSON from live routes, inbound requests, and connection audit. */
export function dashboardStatus(
  secretConfigured: boolean,
  routes: DashboardRoute[],
  connectionLog: ConnectionLogEvent[] = [],
  inboundLog: InboundLogEvent[] = [],
  oauthCallbackPaths: OAuthCallbackPathRow[] = []
): DashboardStatus {
  const active = routes.filter((route) => route.subscribers.length > 0);
  return {
    ok: true,
    secretConfigured,
    generatedAt: new Date().toISOString(),
    routeCount: active.length,
    subscriberCount: active.reduce((sum, route) => sum + route.subscribers.length, 0),
    routes: active,
    oauthCallbackPaths,
    inboundLog,
    connectionLog
  };
}

const DASHBOARD_CSS = `
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
    main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
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
    .section-title { font-size: 1.05rem; font-weight: 650; margin: 8px 0 12px; }
    .history { margin-top: 12px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .empty { color: var(--muted); padding: 24px; text-align: center; }
    .event-connected, .result-accepted { color: var(--ok); }
    .result-proxied { color: var(--accent); }
    .event-rejected, .result-rejected { color: var(--warn); }
    .hint { color: var(--muted); font-size: 13px; margin: -4px 0 12px; }
    .error-code { color: var(--muted); font-size: 12px; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .meta form { margin: 0; }
    .meta button, .login button {
      font: inherit;
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .login { max-width: 360px; }
    .login label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
    .login input {
      width: 100%;
      font: inherit;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    .error { color: var(--warn); margin: 0 0 12px; }
    .oauth-form {
      display: grid;
      grid-template-columns: minmax(120px, 1fr) minmax(180px, 2fr) auto;
      gap: 8px;
      align-items: end;
      margin-top: 12px;
    }
    .oauth-form label { display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
    .oauth-form input {
      width: 100%;
      font: inherit;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
    }
    .oauth-form button, .oauth-delete button {
      font: inherit;
      color: var(--text);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
    }
    .oauth-delete { margin: 0; }
    @media (max-width: 720px) {
      .oauth-form { grid-template-columns: 1fr; }
    }
`;

export function dashboardLoginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dev router dashboard</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <main>
    <h1>Dev router</h1>
    <p class="lede">Sign in to view worker health, live subscriber connections, inbound requests, and the connection audit log.</p>
    <form class="card login" method="post" action="/dashboard/login">
      <label for="password">Dashboard password</label>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

export function dashboardHtml(status: DashboardStatus): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dev router dashboard</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <main>
    <h1>Dev router</h1>
    <p class="lede">Worker health, live subscriber connections, inbound request stream, and a historical connection audit log.</p>
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
    <h2 class="section-title">Live connections</h2>
    <div id="routes">${renderRoutes(status.routes)}</div>
    <h2 class="section-title">OAuth callback paths</h2>
    <p class="hint">Only these remaining paths are reverse-proxied. Unregistered <code>/oauth/callback</code> and <code>/auth/callback</code> URLs are rejected (not proxied, not webhook fan-out). Register the redirect URI before pointing the provider at the Public URL.</p>
    <div id="oauth-callbacks">${renderOAuthCallbackPaths(status.oauthCallbackPaths)}</div>
    <h2 class="section-title">Inbound requests</h2>
    <p class="hint">Metadata only. Bodies, query strings, and headers are not stored.</p>
    <div id="inbound">${renderInboundLog(status.inboundLog)}</div>
    <h2 class="section-title">Connection history</h2>
    <div id="history">${renderConnectionLog(status.connectionLog)}</div>
    <p class="meta">
      <span>Updated <span id="updated">${escapeHtml(status.generatedAt)}</span> · auto-refresh 5s</span>
      <form method="post" action="/dashboard/logout"><button type="submit">Sign out</button></form>
    </p>
  </main>
  <script>
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
      document.getElementById("oauth-callbacks").innerHTML = oauthCallbackHtml(data.oauthCallbackPaths || []);
      document.getElementById("inbound").innerHTML = inboundHtml(data.inboundLog || []);
      document.getElementById("history").innerHTML = historyHtml(data.connectionLog || []);
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
            <td>\${sub.environmentId ? \`<code>\${esc(sub.environmentId)}</code>\` : "—"}</td>
            <td>\${esc(sub.transport || "public")}</td>
            <td><code>\${esc(sub.targetBaseUrl)}</code></td>
            <td>\${fmt(sub.lastHeartbeatAt)}</td>
            <td>\${fmt(sub.expiresAt)}</td>
          </tr>\`).join("");
        return \`<div class="card route"><h2>\${esc(route.publicPath)}</h2>
          <div class="table-wrap"><table><thead><tr><th>Subscriber</th><th>Environment id</th><th>Transport</th><th>Target</th><th>Last heartbeat</th><th>Expires</th></tr></thead>
          <tbody>\${rows}</tbody></table></div></div>\`;
      }).join("");
    }
    function oauthCallbackHtml(paths) {
      const empty = !paths.length
        ? '<p class="hint warn">No OAuth callback paths registered. Heuristic <code>/oauth/callback</code> and <code>/auth/callback</code> URLs are rejected — not a reverse proxy and not webhook fan-out.</p>'
        : "";
      const rows = paths.map((row) => \`
        <tr>
          <td><code>\${esc(row.routeId === "" ? "/* (root)" : "/" + row.routeId + "/*")}</code></td>
          <td><code>\${esc(row.remainingPath)}</code></td>
          <td>\${fmt(row.createdAt)}</td>
          <td>
            <form class="oauth-delete" method="post" action="/dashboard/oauth-callback-paths/delete">
              <input type="hidden" name="routeId" value="\${esc(row.routeId)}" />
              <input type="hidden" name="path" value="\${esc(row.remainingPath)}" />
              <button type="submit">Remove</button>
            </form>
          </td>
        </tr>\`).join("");
      return \`<div class="card">
        \${empty}
        <div class="table-wrap"><table>
          <thead><tr><th>Route</th><th>Remaining path</th><th>Registered</th><th></th></tr></thead>
          <tbody>\${rows}</tbody>
        </table></div>
        <form class="oauth-form" method="post" action="/dashboard/oauth-callback-paths">
          <div>
            <label for="oauth-route">Route id</label>
            <input id="oauth-route" name="routeId" placeholder="(empty = root)" autocomplete="off" />
          </div>
          <div>
            <label for="oauth-path">Remaining path</label>
            <input id="oauth-path" name="path" placeholder="/api/auth/callback/google" required autocomplete="off" />
          </div>
          <button type="submit">Register</button>
        </form>
      </div>\`;
    }
    function inboundHtml(events) {
      if (!events.length) {
        return '<div class="card empty">No inbound requests recorded yet.</div>';
      }
      const rows = events.map((event) => \`
        <tr>
          <td>\${fmt(event.occurredAt)}</td>
          <td><code>\${esc(event.id)}</code></td>
          <td>\${esc(event.kind)}</td>
          <td>\${esc(event.method)}</td>
          <td>\${event.routeId == null ? "—" : \`<code>\${esc(publicPath(event.routeId))}</code>\`}</td>
          <td><code>\${esc(event.path)}\${event.hasQuery ? "?" : ""}</code></td>
          <td class="\${resultClass(event.result)}">\${esc(event.result)}</td>
          <td>\${esc(String(event.status))}\${event.error ? \` <span class="error-code">\${esc(event.error)}</span>\` : ""}</td>
          <td>\${esc(String(event.subscriberCount))}</td>
          <td>\${esc(formatBytes(event.bodyBytes))}</td>
        </tr>\`).join("");
      return \`<div class="card history"><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Request</th><th>Kind</th><th>Method</th><th>Route</th><th>Path</th><th>Result</th><th>Status</th><th>Subscribers</th><th>Size</th></tr></thead>
        <tbody>\${rows}</tbody></table></div></div>\`;
    }
    function historyHtml(events) {
      if (!events.length) {
        return '<div class="card empty">No historical connections recorded yet.</div>';
      }
      const rows = events.map((event) => \`
        <tr>
          <td>\${fmt(event.occurredAt)}</td>
          <td class="\${eventClass(event.action)}">\${esc(event.action)}</td>
          <td>\${esc(event.reason)}</td>
          <td><code>\${esc(publicPath(event.routeId))}</code></td>
          <td>\${event.subscriberId ? \`<code>\${esc(event.subscriberId)}</code>\` : "—"}</td>
          <td>\${event.environmentId ? \`<code>\${esc(event.environmentId)}</code>\` : "—"}</td>
          <td>\${event.transport ? esc(event.transport) : "—"}</td>
          <td>\${event.targetBaseUrl ? \`<code>\${esc(event.targetBaseUrl)}</code>\` : "—"}</td>
          <td>\${event.clientIp ? \`<code>\${esc(event.clientIp)}</code>\` : "—"}</td>
        </tr>\`).join("");
      return \`<div class="card history"><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Event</th><th>Reason</th><th>Route</th><th>Subscriber</th><th>Environment id</th><th>Transport</th><th>Target</th><th>Client IP</th></tr></thead>
        <tbody>\${rows}</tbody></table></div></div>\`;
    }
    function publicPath(routeId) {
      return routeId ? "/" + routeId + "/*" : "/*";
    }
    function eventClass(action) {
      if (action === "rejected") return "event-rejected";
      if (action === "connected") return "event-connected";
      return "";
    }
    function resultClass(result) {
      if (result === "rejected") return "result-rejected";
      if (result === "accepted") return "result-accepted";
      if (result === "proxied") return "result-proxied";
      return "";
    }
    function formatBytes(n) {
      const bytes = Number(n);
      if (!Number.isFinite(bytes) || bytes < 1024) return String(Math.max(0, Math.floor(bytes) || 0)) + " B";
      return (bytes / 1024).toFixed(1) + " KB";
    }
    function esc(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[ch]));
    }
    async function refresh() {
      try {
        const res = await fetch("/dashboard/status", { cache: "no-store", credentials: "same-origin" });
        if (res.ok) render(await res.json());
      } catch {}
    }
    void refresh();
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
            <td>${sub.environmentId ? `<code>${escapeHtml(sub.environmentId)}</code>` : "—"}</td>
            <td>${escapeHtml(sub.transport)}</td>
            <td><code>${escapeHtml(sub.targetBaseUrl)}</code></td>
            <td>${escapeHtml(new Date(sub.lastHeartbeatAt).toISOString())}</td>
            <td>${escapeHtml(new Date(sub.expiresAt).toISOString())}</td>
          </tr>`
        )
        .join("");
      return `<div class="card route"><h2>${escapeHtml(route.publicPath)}</h2>
        <div class="table-wrap"><table><thead><tr><th>Subscriber</th><th>Environment id</th><th>Transport</th><th>Target</th><th>Last heartbeat</th><th>Expires</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
    })
    .join("");
}

function renderOAuthCallbackPaths(paths: OAuthCallbackPathRow[]): string {
  const empty =
    paths.length === 0
      ? `<p class="hint warn">No OAuth callback paths registered. Heuristic <code>/oauth/callback</code> and <code>/auth/callback</code> URLs are rejected — not a reverse proxy and not webhook fan-out.</p>`
      : "";
  const rows = paths
    .map((row) => {
      const routeLabel = row.routeId === "" ? "/* (root)" : publicPathForRouteId(row.routeId);
      return `<tr>
            <td><code>${escapeHtml(routeLabel)}</code></td>
            <td><code>${escapeHtml(row.remainingPath)}</code></td>
            <td>${escapeHtml(new Date(row.createdAt).toISOString())}</td>
            <td>
              <form class="oauth-delete" method="post" action="/dashboard/oauth-callback-paths/delete">
                <input type="hidden" name="routeId" value="${escapeHtml(row.routeId)}" />
                <input type="hidden" name="path" value="${escapeHtml(row.remainingPath)}" />
                <button type="submit">Remove</button>
              </form>
            </td>
          </tr>`;
    })
    .join("");
  return `<div class="card">
        ${empty}
        <div class="table-wrap"><table>
          <thead><tr><th>Route</th><th>Remaining path</th><th>Registered</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <form class="oauth-form" method="post" action="/dashboard/oauth-callback-paths">
          <div>
            <label for="oauth-route">Route id</label>
            <input id="oauth-route" name="routeId" placeholder="(empty = root)" autocomplete="off" />
          </div>
          <div>
            <label for="oauth-path">Remaining path</label>
            <input id="oauth-path" name="path" placeholder="/api/auth/callback/google" required autocomplete="off" />
          </div>
          <button type="submit">Register</button>
        </form>
      </div>`;
}

function renderInboundLog(events: InboundLogEvent[]): string {
  if (events.length === 0) {
    return '<div class="card empty">No inbound requests recorded yet.</div>';
  }
  const rows = events
    .map((event) => {
      const resultClass =
        event.result === "rejected"
          ? "result-rejected"
          : event.result === "accepted"
            ? "result-accepted"
            : event.result === "proxied"
              ? "result-proxied"
              : "";
      const route =
        event.routeId == null
          ? "—"
          : `<code>${escapeHtml(publicPathForRouteId(event.routeId))}</code>`;
      const error = event.error
        ? ` <span class="error-code">${escapeHtml(event.error)}</span>`
        : "";
      return `<tr>
            <td>${escapeHtml(new Date(event.occurredAt).toISOString())}</td>
            <td><code>${escapeHtml(event.id)}</code></td>
            <td>${escapeHtml(event.kind)}</td>
            <td>${escapeHtml(event.method)}</td>
            <td>${route}</td>
            <td><code>${escapeHtml(event.path)}${event.hasQuery ? "?" : ""}</code></td>
            <td class="${resultClass}">${escapeHtml(event.result)}</td>
            <td>${escapeHtml(String(event.status))}${error}</td>
            <td>${escapeHtml(String(event.subscriberCount))}</td>
            <td>${escapeHtml(formatInboundBodyBytes(event.bodyBytes))}</td>
          </tr>`;
    })
    .join("");
  return `<div class="card history"><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Request</th><th>Kind</th><th>Method</th><th>Route</th><th>Path</th><th>Result</th><th>Status</th><th>Subscribers</th><th>Size</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
}

function renderConnectionLog(events: ConnectionLogEvent[]): string {
  if (events.length === 0) {
    return '<div class="card empty">No historical connections recorded yet.</div>';
  }
  const rows = events
    .map((event) => {
      const eventClass =
        event.action === "rejected"
          ? "event-rejected"
          : event.action === "connected"
            ? "event-connected"
            : "";
      return `<tr>
            <td>${escapeHtml(new Date(event.occurredAt).toISOString())}</td>
            <td class="${eventClass}">${escapeHtml(event.action)}</td>
            <td>${escapeHtml(event.reason)}</td>
            <td><code>${escapeHtml(publicPathForRouteId(event.routeId))}</code></td>
            <td>${event.subscriberId ? `<code>${escapeHtml(event.subscriberId)}</code>` : "—"}</td>
            <td>${event.environmentId ? `<code>${escapeHtml(event.environmentId)}</code>` : "—"}</td>
            <td>${event.transport ? escapeHtml(event.transport) : "—"}</td>
            <td>${event.targetBaseUrl ? `<code>${escapeHtml(event.targetBaseUrl)}</code>` : "—"}</td>
            <td>${event.clientIp ? `<code>${escapeHtml(event.clientIp)}</code>` : "—"}</td>
          </tr>`;
    })
    .join("");
  return `<div class="card history"><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Event</th><th>Reason</th><th>Route</th><th>Subscriber</th><th>Environment id</th><th>Transport</th><th>Target</th><th>Client IP</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
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

export const DASHBOARD_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'";

export function dashboardHtmlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": DASHBOARD_CSP
  };
}
