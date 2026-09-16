import { randomHex } from "./random-hex";
import type { SubscriberTransport } from "./dev-router-types";
import {
  CONNECTION_LOG_DASHBOARD_LIMIT,
  CONNECTION_LOG_MAX_EVENTS,
  CONNECTION_LOG_RETENTION_MS,
  connectionLogTargetBaseUrl,
  sanitizeClientIp,
  type ConnectionLogAction,
  type ConnectionLogEvent,
  type ConnectionLogEventInput,
  type ConnectionLogReason
} from "./connection-log";

interface ConnectionEventRow {
  id: string;
  occurred_at: number;
  action: string;
  reason: string;
  route_id: string;
  subscriber_id: string | null;
  environment_id: string | null;
  transport: string | null;
  target_base_url: string | null;
  client_ip: string | null;
  [key: string]: SqlStorageValue;
}

const ACTIONS = new Set<string>(["connected", "disconnected", "rejected"]);
const REASONS = new Set<string>([
  "registered",
  "reclaimed",
  "replaced",
  "deregistered",
  "socket_closed",
  "expired",
  "stale_tunnel",
  "unauthorized",
  "environment_in_use"
]);

/** Create the connection audit log table on the router index Durable Object. */
export function migrateConnectionLog(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS connection_events (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      route_id TEXT NOT NULL,
      subscriber_id TEXT,
      environment_id TEXT,
      transport TEXT,
      target_base_url TEXT,
      client_ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_connection_events_occurred_at
      ON connection_events (occurred_at DESC);
  `);
}

/** Append connection audit events and drop entries older than retention or over the cap. */
export function insertConnectionLogEvents(
  sql: SqlStorage,
  events: ConnectionLogEventInput[],
  now = Date.now()
): void {
  for (const event of events) {
    sql.exec(
      `INSERT INTO connection_events (
         id, occurred_at, action, reason, route_id, subscriber_id,
         environment_id, transport, target_base_url, client_ip
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `clog_${randomHex(8)}`,
      event.occurredAt ?? now,
      event.action,
      event.reason,
      event.routeId,
      event.subscriberId ?? null,
      event.environmentId ?? null,
      event.transport ?? null,
      event.targetBaseUrl ?? null,
      sanitizeClientIp(event.clientIp ?? null)
    );
  }
  purgeConnectionLogEvents(sql, now);
}

/** Newest connection audit events still within the retention window. */
export function listConnectionLogEvents(
  sql: SqlStorage,
  limit = CONNECTION_LOG_DASHBOARD_LIMIT,
  now = Date.now()
): ConnectionLogEvent[] {
  purgeConnectionLogEvents(sql, now);
  const rows = sql
    .exec<ConnectionEventRow>(
      `SELECT id, occurred_at, action, reason, route_id, subscriber_id,
              environment_id, transport, target_base_url, client_ip
       FROM connection_events
       WHERE occurred_at >= ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
      now - CONNECTION_LOG_RETENTION_MS,
      Math.max(1, Math.min(limit, CONNECTION_LOG_MAX_EVENTS))
    )
    .toArray();
  return rows.map(toConnectionLogEvent).filter((event): event is ConnectionLogEvent => event !== null);
}

/** Drop connection audit events older than 90 days or beyond the stored cap. */
export function purgeConnectionLogEvents(sql: SqlStorage, now = Date.now()): void {
  sql.exec(
    "DELETE FROM connection_events WHERE occurred_at < ?",
    now - CONNECTION_LOG_RETENTION_MS
  );
  const count = sql
    .exec<{ count: number }>("SELECT COUNT(*) as count FROM connection_events")
    .one().count;
  const overflow = count - CONNECTION_LOG_MAX_EVENTS;
  if (overflow > 0) {
    sql.exec(
      `DELETE FROM connection_events WHERE id IN (
         SELECT id FROM connection_events ORDER BY occurred_at ASC, id ASC LIMIT ?
       )`,
      overflow
    );
  }
}

function toConnectionLogEvent(row: ConnectionEventRow): ConnectionLogEvent | null {
  if (!ACTIONS.has(row.action) || !REASONS.has(row.reason)) {
    return null;
  }
  const transport =
    row.transport === "tunnel" || row.transport === "public" ? row.transport : null;
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.action as ConnectionLogAction,
    reason: row.reason as ConnectionLogReason,
    routeId: row.route_id,
    subscriberId: row.subscriber_id,
    environmentId: row.environment_id,
    transport,
    targetBaseUrl: connectionLogTargetBaseUrl(transport, row.target_base_url),
    clientIp: row.client_ip
  };
}
