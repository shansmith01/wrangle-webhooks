import { DurableObject } from "cloudflare:workers";
import {
  type ConnectionLogEvent,
  type ConnectionLogEventInput
} from "./connection-log";
import {
  insertConnectionLogEvents,
  listConnectionLogEvents,
  migrateConnectionLog
} from "./connection-log-storage";
import {
  type InboundLogEvent,
  type InboundLogEventInput
} from "./inbound-log";
import {
  insertInboundLogEvents,
  listInboundLogEvents,
  migrateInboundLog
} from "./inbound-log-storage";
import type { OAuthCallbackPathRow } from "./oauth-callback-path";
import {
  deleteOAuthCallbackPath,
  listAllOAuthCallbackPaths,
  listOAuthCallbackPathsForRoute,
  migrateOAuthCallbackPaths,
  upsertOAuthCallbackPath
} from "./oauth-callback-path-storage";
import { durableObjectNameForIndex, isAllowedRouteId, isValidRouteId } from "./route-id";

interface RouteRow {
  route_id: string;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

/** Durable Object stub for the router-wide index of active routes. */
export function routerIndexStub(env: Env): DurableObjectStub<RouterIndex> {
  return env.ROUTER_INDEX.getByName(durableObjectNameForIndex());
}

/** Router-wide index of active routes, connection audit log, inbound metadata, and OAuth callback allowlist. */
export class RouterIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS routes (
        route_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      )
    `);
    migrateConnectionLog(this.ctx.storage.sql);
    migrateInboundLog(this.ctx.storage.sql);
    migrateOAuthCallbackPaths(this.ctx.storage.sql);
  }

  async addRoute(routeId: string): Promise<void> {
    if (!isAllowedRouteId(routeId)) {
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO routes (route_id, updated_at) VALUES (?, ?)
       ON CONFLICT(route_id) DO UPDATE SET updated_at = excluded.updated_at`,
      routeId,
      Date.now()
    );
  }

  async removeRoute(routeId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM routes WHERE route_id = ?", routeId);
  }

  async listRoutes(): Promise<string[]> {
    const rows = this.ctx.storage.sql
      .exec<RouteRow>("SELECT route_id, updated_at FROM routes ORDER BY route_id ASC")
      .toArray();
    return rows.map((row) => row.route_id);
  }

  /**
   * Whether the first path segment is an indexed named route, and whether a
   * root catch-all is indexed. Public ingress uses this so unmatched scanner
   * probes do not instantiate Route Durable Objects.
   */
  async indexedPublicRoutePresence(namedRouteId: string | undefined): Promise<{
    named: boolean;
    root: boolean;
  }> {
    if (namedRouteId && isValidRouteId(namedRouteId)) {
      const rows = this.ctx.storage.sql
        .exec<RouteRow>(
          "SELECT route_id, updated_at FROM routes WHERE route_id = ? OR route_id = ''",
          namedRouteId
        )
        .toArray();
      const ids = new Set(rows.map((row) => row.route_id));
      return { named: ids.has(namedRouteId), root: ids.has("") };
    }
    const root = this.ctx.storage.sql
      .exec<RouteRow>("SELECT route_id, updated_at FROM routes WHERE route_id = ''")
      .toArray();
    return { named: false, root: root.length > 0 };
  }

  /** Append client connection audit events for operator review. */
  async recordConnectionEvents(events: ConnectionLogEventInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    insertConnectionLogEvents(this.ctx.storage.sql, events);
  }

  /** Historical client connections, newest first, including routes with no live subscribers. */
  async listConnectionEvents(limit?: number): Promise<ConnectionLogEvent[]> {
    return listConnectionLogEvents(this.ctx.storage.sql, limit);
  }

  /** Append inbound public-request metadata for the dashboard stream. */
  async recordInboundEvents(events: InboundLogEventInput[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    insertInboundLogEvents(this.ctx.storage.sql, events);
  }

  /** Inbound public requests, newest first, metadata only (no body, query, or headers). */
  async listInboundEvents(limit?: number): Promise<InboundLogEvent[]> {
    return listInboundLogEvents(this.ctx.storage.sql, limit);
  }

  /** Remaining paths allowlisted for OAuth reverse proxy on this route. */
  async listOAuthCallbackPaths(routeId: string): Promise<string[]> {
    return listOAuthCallbackPathsForRoute(this.ctx.storage.sql, routeId);
  }

  /** All allowlisted OAuth callback paths across routes, for the dashboard. */
  async listAllOAuthCallbackPaths(): Promise<OAuthCallbackPathRow[]> {
    return listAllOAuthCallbackPaths(this.ctx.storage.sql);
  }

  /** Register an exact remaining path for OAuth reverse proxy on this route. */
  async addOAuthCallbackPath(
    routeId: string,
    remainingPath: string
  ): Promise<OAuthCallbackPathRow | null> {
    return upsertOAuthCallbackPath(this.ctx.storage.sql, routeId, remainingPath);
  }

  /** Remove an allowlisted OAuth callback remaining path for this route. */
  async removeOAuthCallbackPath(routeId: string, remainingPath: string): Promise<boolean> {
    return deleteOAuthCallbackPath(this.ctx.storage.sql, routeId, remainingPath);
  }
}
