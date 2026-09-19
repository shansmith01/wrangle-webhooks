import {
  normalizeOAuthCallbackPath,
  validateOAuthCallbackPath,
  type OAuthCallbackPathRow
} from "./oauth-callback-path";
import { isAllowedRouteId } from "./route-id";

interface OAuthCallbackPathSqlRow {
  route_id: string;
  remaining_path: string;
  created_at: number;
  [key: string]: SqlStorageValue;
}

/** Create the OAuth callback path allowlist table on the router index Durable Object. */
export function migrateOAuthCallbackPaths(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS oauth_callback_paths (
      route_id TEXT NOT NULL,
      remaining_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (route_id, remaining_path)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_callback_paths_route_id
      ON oauth_callback_paths (route_id);
  `);
}

/** Insert or replace one allowlisted OAuth callback remaining path for a route. */
export function upsertOAuthCallbackPath(
  sql: SqlStorage,
  routeId: string,
  remainingPath: string,
  now = Date.now()
): OAuthCallbackPathRow | null {
  if (!isAllowedRouteId(routeId)) {
    return null;
  }
  const path = validateOAuthCallbackPath(remainingPath);
  if (!path) {
    return null;
  }
  sql.exec(
    `INSERT INTO oauth_callback_paths (route_id, remaining_path, created_at) VALUES (?, ?, ?)
     ON CONFLICT(route_id, remaining_path) DO UPDATE SET created_at = excluded.created_at`,
    routeId,
    path,
    now
  );
  return { routeId, remainingPath: path, createdAt: now };
}

/** Remove one allowlisted OAuth callback remaining path for a route. */
export function deleteOAuthCallbackPath(
  sql: SqlStorage,
  routeId: string,
  remainingPath: string
): boolean {
  if (!isAllowedRouteId(routeId)) {
    return false;
  }
  const path = normalizeOAuthCallbackPath(remainingPath);
  const before = sql
    .exec<{ c: number }>(
      "SELECT COUNT(*) as c FROM oauth_callback_paths WHERE route_id = ? AND remaining_path = ?",
      routeId,
      path
    )
    .one().c;
  if (before === 0) {
    return false;
  }
  sql.exec(
    "DELETE FROM oauth_callback_paths WHERE route_id = ? AND remaining_path = ?",
    routeId,
    path
  );
  return true;
}

/** Remaining paths allowlisted for OAuth reverse proxy on this route. */
export function listOAuthCallbackPathsForRoute(
  sql: SqlStorage,
  routeId: string
): string[] {
  if (!isAllowedRouteId(routeId)) {
    return [];
  }
  const rows = sql
    .exec<OAuthCallbackPathSqlRow>(
      `SELECT route_id, remaining_path, created_at FROM oauth_callback_paths
       WHERE route_id = ? ORDER BY remaining_path ASC`,
      routeId
    )
    .toArray();
  return rows.map((row) => row.remaining_path);
}

/** All allowlisted OAuth callback paths across routes, for the dashboard. */
export function listAllOAuthCallbackPaths(sql: SqlStorage): OAuthCallbackPathRow[] {
  const rows = sql
    .exec<OAuthCallbackPathSqlRow>(
      `SELECT route_id, remaining_path, created_at FROM oauth_callback_paths
       ORDER BY route_id ASC, remaining_path ASC`
    )
    .toArray();
  return rows.map((row) => ({
    routeId: row.route_id,
    remainingPath: row.remaining_path,
    createdAt: row.created_at
  }));
}
