import {
  INBOUND_LOG_DASHBOARD_LIMIT,
  INBOUND_LOG_MAX_EVENTS,
  INBOUND_LOG_RETENTION_MS,
  buildInboundLogEvent,
  type InboundLogEvent,
  type InboundLogEventInput,
  type InboundLogError,
  type InboundLogKind,
  type InboundLogResult
} from "./inbound-log";

interface InboundEventRow {
  id: string;
  occurred_at: number;
  method: string;
  route_id: string | null;
  path: string;
  has_query: number;
  kind: string;
  result: string;
  status: number;
  error: string | null;
  subscriber_count: number;
  body_bytes: number;
  [key: string]: SqlStorageValue;
}

const KINDS = new Set<string>(["webhook", "oauth"]);
const RESULTS = new Set<string>(["accepted", "proxied", "rejected"]);
const ERRORS = new Set<string>([
  "route_not_found",
  "oauth_unroutable",
  "oauth_subscriber_not_found",
  "request_too_large",
  "subscriber_unreachable"
]);

/** Create the inbound request metadata table on the router index Durable Object. */
export function migrateInboundLog(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS inbound_events (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      method TEXT NOT NULL,
      route_id TEXT,
      path TEXT NOT NULL,
      has_query INTEGER NOT NULL,
      kind TEXT NOT NULL,
      result TEXT NOT NULL,
      status INTEGER NOT NULL,
      error TEXT,
      subscriber_count INTEGER NOT NULL,
      body_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_events_occurred_at
      ON inbound_events (occurred_at DESC);
  `);
}

/** Append inbound request metadata and drop entries older than retention or over the cap. */
export function insertInboundLogEvents(
  sql: SqlStorage,
  events: InboundLogEventInput[],
  now = Date.now()
): void {
  for (const input of events) {
    const event = buildInboundLogEvent({ ...input, occurredAt: input.occurredAt ?? now });
    sql.exec(
      `INSERT OR REPLACE INTO inbound_events (
         id, occurred_at, method, route_id, path, has_query, kind, result,
         status, error, subscriber_count, body_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.occurredAt,
      event.method,
      event.routeId,
      event.path,
      event.hasQuery ? 1 : 0,
      event.kind,
      event.result,
      event.status,
      event.error,
      event.subscriberCount,
      event.bodyBytes
    );
  }
  purgeInboundLogEvents(sql, now);
}

/** Newest inbound request metadata still within the retention window. */
export function listInboundLogEvents(
  sql: SqlStorage,
  limit = INBOUND_LOG_DASHBOARD_LIMIT,
  now = Date.now()
): InboundLogEvent[] {
  purgeInboundLogEvents(sql, now);
  const rows = sql
    .exec<InboundEventRow>(
      `SELECT id, occurred_at, method, route_id, path, has_query, kind, result,
              status, error, subscriber_count, body_bytes
       FROM inbound_events
       WHERE occurred_at >= ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
      now - INBOUND_LOG_RETENTION_MS,
      Math.max(1, Math.min(limit, INBOUND_LOG_MAX_EVENTS))
    )
    .toArray();
  return rows.map(toInboundLogEvent).filter((event): event is InboundLogEvent => event !== null);
}

/** Drop inbound request metadata older than 7 days or beyond the stored cap. */
export function purgeInboundLogEvents(sql: SqlStorage, now = Date.now()): void {
  sql.exec(
    "DELETE FROM inbound_events WHERE occurred_at < ?",
    now - INBOUND_LOG_RETENTION_MS
  );
  const count = sql
    .exec<{ count: number }>("SELECT COUNT(*) as count FROM inbound_events")
    .one().count;
  const overflow = count - INBOUND_LOG_MAX_EVENTS;
  if (overflow > 0) {
    sql.exec(
      `DELETE FROM inbound_events WHERE id IN (
         SELECT id FROM inbound_events ORDER BY occurred_at ASC, id ASC LIMIT ?
       )`,
      overflow
    );
  }
}

function toInboundLogEvent(row: InboundEventRow): InboundLogEvent | null {
  if (!KINDS.has(row.kind) || !RESULTS.has(row.result)) {
    return null;
  }
  const error =
    row.error && ERRORS.has(row.error) ? (row.error as InboundLogError) : null;
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    method: row.method,
    routeId: row.route_id,
    path: row.path,
    hasQuery: row.has_query === 1,
    kind: row.kind as InboundLogKind,
    result: row.result as InboundLogResult,
    status: row.status,
    error,
    subscriberCount: row.subscriber_count,
    bodyBytes: row.body_bytes
  };
}
