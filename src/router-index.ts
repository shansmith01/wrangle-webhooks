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
import { durableObjectNameForIndex, isAllowedRouteId } from "./route-id";

interface RouteRow {
  route_id: string;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

/** Durable Object stub for the router-wide index of active routes. */
export function routerIndexStub(env: Env): DurableObjectStub<RouterIndex> {
  return env.ROUTER_INDEX.getByName(durableObjectNameForIndex());
}

/** Router-wide index of active routes and the historical connection audit log. */
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
}
