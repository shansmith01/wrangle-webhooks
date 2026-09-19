import { isAllowedRouteId } from "./route-id";
import {
  parseWebhookFilterEnvironmentId,
  validateWebhookFanoutRuleMode,
  validateWebhookFilterPath
} from "./webhook-filter-path";
import type { WebhookFanoutRule, WebhookFanoutSettings } from "./webhook-path-filter";

/** Maximum webhook path prefix rules stored per route. */
export const WEBHOOK_FANOUT_RULE_LIMIT = 32;

interface WebhookFanoutSettingsSqlRow {
  route_id: string;
  deny_all_webhooks: number;
  [key: string]: SqlStorageValue;
}

interface WebhookFanoutRuleSqlRow {
  route_id: string;
  mode: string;
  remaining_path: string;
  environment_id: string;
  created_at: number;
  [key: string]: SqlStorageValue;
}

/** Failure code when a webhook fan-out rule cannot be stored. */
export type WebhookFanoutRuleWriteError =
  | "invalid_route_id"
  | "invalid_webhook_filter_path"
  | "invalid_webhook_fanout_mode"
  | "invalid_environment_id"
  | "webhook_fanout_rule_limit";

/** Create webhook fan-out settings and path-rule tables on the router index Durable Object. */
export function migrateWebhookFanoutSettings(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS webhook_fanout_settings (
      route_id TEXT PRIMARY KEY,
      deny_all_webhooks INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_fanout_rules (
      route_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      remaining_path TEXT NOT NULL,
      environment_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (route_id, mode, remaining_path, environment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_fanout_rules_route_id
      ON webhook_fanout_rules (route_id);
  `);
}

/** Route deny-all flag plus path rules for webhook fan-out on this route. */
export function getWebhookFanoutSettings(
  sql: SqlStorage,
  routeId: string
): WebhookFanoutSettings {
  if (!isAllowedRouteId(routeId)) {
    return { routeId, denyAllWebhooks: false, rules: [] };
  }
  const settingsRow = sql
    .exec<WebhookFanoutSettingsSqlRow>(
      `SELECT route_id, deny_all_webhooks FROM webhook_fanout_settings WHERE route_id = ?`,
      routeId
    )
    .toArray()[0];
  return {
    routeId,
    denyAllWebhooks: Boolean(settingsRow?.deny_all_webhooks),
    rules: listWebhookFanoutRulesForRoute(sql, routeId)
  };
}

/** Persist the route-level deny-all webhook fan-out checkbox. */
export function setWebhookFanoutDenyAll(
  sql: SqlStorage,
  routeId: string,
  denyAllWebhooks: boolean,
  now = Date.now()
): WebhookFanoutSettings | null {
  if (!isAllowedRouteId(routeId)) {
    return null;
  }
  sql.exec(
    `INSERT INTO webhook_fanout_settings (route_id, deny_all_webhooks, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(route_id) DO UPDATE SET
       deny_all_webhooks = excluded.deny_all_webhooks,
       updated_at = excluded.updated_at`,
    routeId,
    denyAllWebhooks ? 1 : 0,
    now
  );
  return getWebhookFanoutSettings(sql, routeId);
}

/** All route deny-all flags, for the dashboard. */
export function listAllWebhookFanoutSettings(
  sql: SqlStorage
): Array<{ routeId: string; denyAllWebhooks: boolean }> {
  const rows = sql
    .exec<WebhookFanoutSettingsSqlRow>(
      `SELECT route_id, deny_all_webhooks FROM webhook_fanout_settings
       ORDER BY route_id ASC`
    )
    .toArray();
  return rows.map((row) => ({
    routeId: row.route_id,
    denyAllWebhooks: Boolean(row.deny_all_webhooks)
  }));
}

/** Path prefix rules for webhook fan-out on this route. */
export function listWebhookFanoutRulesForRoute(
  sql: SqlStorage,
  routeId: string
): WebhookFanoutRule[] {
  if (!isAllowedRouteId(routeId)) {
    return [];
  }
  const rows = sql
    .exec<WebhookFanoutRuleSqlRow>(
      `SELECT route_id, mode, remaining_path, environment_id, created_at
       FROM webhook_fanout_rules
       WHERE route_id = ?
       ORDER BY mode ASC, remaining_path ASC, environment_id ASC`,
      routeId
    )
    .toArray();
  return rows.map(toWebhookFanoutRule);
}

/** All webhook path prefix rules across routes, for the dashboard. */
export function listAllWebhookFanoutRules(sql: SqlStorage): WebhookFanoutRule[] {
  const rows = sql
    .exec<WebhookFanoutRuleSqlRow>(
      `SELECT route_id, mode, remaining_path, environment_id, created_at
       FROM webhook_fanout_rules
       ORDER BY route_id ASC, mode ASC, remaining_path ASC, environment_id ASC`
    )
    .toArray();
  return rows.map(toWebhookFanoutRule);
}

/** Insert or replace one webhook path prefix rule; rejects the 33rd distinct rule on a route. */
export function upsertWebhookFanoutRule(
  sql: SqlStorage,
  routeId: string,
  modeRaw: string,
  remainingPath: string,
  environmentIdRaw?: string | null,
  now = Date.now()
): { ok: true; rule: WebhookFanoutRule } | { ok: false; error: WebhookFanoutRuleWriteError } {
  if (!isAllowedRouteId(routeId)) {
    return { ok: false, error: "invalid_route_id" };
  }
  const mode = validateWebhookFanoutRuleMode(modeRaw);
  if (!mode) {
    return { ok: false, error: "invalid_webhook_fanout_mode" };
  }
  const path = validateWebhookFilterPath(remainingPath);
  if (!path) {
    return { ok: false, error: "invalid_webhook_filter_path" };
  }
  const environment = parseWebhookFilterEnvironmentId(environmentIdRaw);
  if (!environment.ok) {
    return { ok: false, error: "invalid_environment_id" };
  }
  const environmentKey = environment.environmentId ?? "";
  const existing = sql
    .exec<{ c: number }>(
      `SELECT COUNT(*) as c FROM webhook_fanout_rules
       WHERE route_id = ? AND mode = ? AND remaining_path = ? AND environment_id = ?`,
      routeId,
      mode,
      path,
      environmentKey
    )
    .one().c;
  if (existing === 0) {
    const count = sql
      .exec<{ c: number }>(
        "SELECT COUNT(*) as c FROM webhook_fanout_rules WHERE route_id = ?",
        routeId
      )
      .one().c;
    if (count >= WEBHOOK_FANOUT_RULE_LIMIT) {
      return { ok: false, error: "webhook_fanout_rule_limit" };
    }
  }
  sql.exec(
    `INSERT INTO webhook_fanout_rules
       (route_id, mode, remaining_path, environment_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(route_id, mode, remaining_path, environment_id)
     DO UPDATE SET created_at = excluded.created_at`,
    routeId,
    mode,
    path,
    environmentKey,
    now
  );
  return {
    ok: true,
    rule: {
      routeId,
      mode,
      remainingPath: path,
      environmentId: environment.environmentId,
      createdAt: now
    }
  };
}

/** Remove one webhook path prefix rule. */
export function deleteWebhookFanoutRule(
  sql: SqlStorage,
  routeId: string,
  modeRaw: string,
  remainingPath: string,
  environmentIdRaw?: string | null
): boolean {
  if (!isAllowedRouteId(routeId)) {
    return false;
  }
  const mode = validateWebhookFanoutRuleMode(modeRaw);
  const path = validateWebhookFilterPath(remainingPath);
  const environment = parseWebhookFilterEnvironmentId(environmentIdRaw);
  if (!mode || !path || !environment.ok) {
    return false;
  }
  const environmentKey = environment.environmentId ?? "";
  const before = sql
    .exec<{ c: number }>(
      `SELECT COUNT(*) as c FROM webhook_fanout_rules
       WHERE route_id = ? AND mode = ? AND remaining_path = ? AND environment_id = ?`,
      routeId,
      mode,
      path,
      environmentKey
    )
    .one().c;
  if (before === 0) {
    return false;
  }
  sql.exec(
    `DELETE FROM webhook_fanout_rules
     WHERE route_id = ? AND mode = ? AND remaining_path = ? AND environment_id = ?`,
    routeId,
    mode,
    path,
    environmentKey
  );
  return true;
}

/** Drop all webhook fan-out settings and path rules (test isolation / operator reset). */
export function clearWebhookFanoutStorage(sql: SqlStorage): void {
  sql.exec("DELETE FROM webhook_fanout_rules");
  sql.exec("DELETE FROM webhook_fanout_settings");
}

function toWebhookFanoutRule(row: WebhookFanoutRuleSqlRow): WebhookFanoutRule {
  return {
    routeId: row.route_id,
    mode: row.mode === "deny" ? "deny" : "allow",
    remainingPath: row.remaining_path,
    environmentId: row.environment_id === "" ? null : row.environment_id,
    createdAt: row.created_at
  };
}
