import { DurableObject } from "cloudflare:workers";
import { SUBSCRIBER_TTL_MS, validateTargetBaseUrl } from "./shared";
import type { Subscriber } from "./types";

interface SubscriberRow {
  id: string;
  target_base_url: string;
  created_at: number;
  last_heartbeat_at: number;
  expires_at: number;
  [key: string]: SqlStorageValue;
}

export class RouteDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const currentVersion = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations"
      )
      .one().version;

    if (currentVersion < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS subscribers (
          id TEXT PRIMARY KEY,
          target_base_url TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_subscribers_expires_at
          ON subscribers (expires_at);
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }
  }

  async register(targetBaseUrl: string): Promise<{
    subscriberId: string;
    expiresIn: number;
  }> {
    const normalized = validateTargetBaseUrl(targetBaseUrl);
    const now = Date.now();
    this.purgeExpired(now);

    const subscriberId = `sub_${randomId()}`;
    const expiresAt = now + SUBSCRIBER_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO subscribers
        (id, target_base_url, created_at, last_heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      subscriberId,
      normalized,
      now,
      now,
      expiresAt
    );
    await this.scheduleCleanup(now);
    return { subscriberId, expiresIn: SUBSCRIBER_TTL_MS / 1000 };
  }

  async heartbeat(subscriberId: string): Promise<{ expiresIn: number } | null> {
    const now = Date.now();
    this.purgeExpired(now);

    const existing = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM subscribers WHERE id = ? AND expires_at > ?",
        subscriberId,
        now
      )
      .toArray()[0];
    if (!existing) {
      return null;
    }

    const expiresAt = now + SUBSCRIBER_TTL_MS;
    this.ctx.storage.sql.exec(
      `UPDATE subscribers
       SET last_heartbeat_at = ?, expires_at = ?
       WHERE id = ?`,
      now,
      expiresAt,
      subscriberId
    );
    await this.scheduleCleanup(now);
    return { expiresIn: SUBSCRIBER_TTL_MS / 1000 };
  }

  async deregister(subscriberId: string): Promise<boolean> {
    const now = Date.now();
    this.purgeExpired(now);
    this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE id = ?", subscriberId);
    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM subscribers")
      .one().count;
    if (remaining === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.scheduleCleanup(now);
    }
    return true;
  }

  async getActiveSubscribers(): Promise<Subscriber[]> {
    const now = Date.now();
    this.purgeExpired(now);
    const rows = this.ctx.storage.sql
      .exec<SubscriberRow>(
        `SELECT id, target_base_url, created_at, last_heartbeat_at, expires_at
         FROM subscribers
         WHERE expires_at > ?
         ORDER BY created_at ASC`,
        now
      )
      .toArray();
    return rows.map(toSubscriber);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.purgeExpired(now);
    await this.scheduleCleanup(now);
  }

  private purgeExpired(now: number): void {
    this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE expires_at <= ?", now);
  }

  private async scheduleCleanup(now: number): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT MIN(expires_at) as expires_at FROM subscribers"
      )
      .toArray()[0];
    if (!next?.expires_at) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(next.expires_at, now + 1_000));
  }
}

function toSubscriber(row: SubscriberRow): Subscriber {
  return {
    id: row.id,
    targetBaseUrl: row.target_base_url,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    expiresAt: row.expires_at
  };
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
