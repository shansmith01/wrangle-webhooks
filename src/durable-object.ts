import { DurableObject } from "cloudflare:workers";
import {
  captureSubscriberResponse,
  buildForwardHeaders,
  deliverToSubscriber,
  filterResponseHeaders
} from "./forward";
import {
  connectionTokenMatches,
  deriveRouteSecret,
  hashConnectionToken,
  randomConnectionToken
} from "./credentials";
import { OAUTH_STATE_MAX_LENGTH, OAUTH_STATE_TTL_MS, unwrapOAuthStateForRoute } from "./oauth-state";
import { randomHex } from "./random-hex";
import { ROUTER_HEADER_CONNECTION } from "./router-headers";
import { durableObjectNameForIndex, isAllowedEnvironmentId } from "./route-id";
import { DELIVERY_TIMEOUT_MS, SUBSCRIBER_TTL_MS } from "./subscriber-lifetime";
import { validateTargetBaseUrl } from "./target-base-url";
import {
  TUNNEL_MAX_BODY_BYTES,
  TUNNEL_PING,
  TUNNEL_PONG,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_SUBPROTOCOL_PREFIX,
  TUNNEL_STALE_MS,
  decodeBody,
  encodeBody,
  headersFromPairs,
  isTunnelError,
  isTunnelHeartbeat,
  isTunnelResponse,
  parseJsonMessage,
  routeIdFromTunnelPath,
  serializeHeaders,
  type TunnelRequestMessage,
  type TunnelResponseMessage
} from "./tunnel-protocol";
import type { IngressPayload, ProxyResult, Subscriber } from "./dev-router-types";

interface SubscriberRow {
  id: string;
  transport: string;
  target_base_url: string;
  forward_token: string;
  connection_token_hash: string;
  environment_id: string | null;
  created_at: number;
  last_heartbeat_at: number;
  expires_at: number;
  [key: string]: SqlStorageValue;
}

interface DeliverySubscriber {
  id: string;
  transport: "public" | "tunnel";
  targetBaseUrl: string;
  forwardToken: string;
}

interface PendingTunnel {
  subscriberId: string;
  resolve: (value: TunnelResponseMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-route Durable Object: subscribers, OAuth bindings, and tunnel sockets. */
export class RouteDurableObject extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingTunnel>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(TUNNEL_PING, TUNNEL_PONG)
    );
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

    if (currentVersion < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE subscribers ADD COLUMN transport TEXT NOT NULL DEFAULT 'public';
        ALTER TABLE subscribers ADD COLUMN forward_token TEXT NOT NULL DEFAULT '';
        CREATE TABLE IF NOT EXISTS oauth_bindings (
          state TEXT PRIMARY KEY,
          subscriber_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_oauth_bindings_expires_at
          ON oauth_bindings (expires_at);
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (2);
      `);
    }

    if (currentVersion < 3) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE subscribers ADD COLUMN environment_id TEXT;
        ALTER TABLE subscribers ADD COLUMN connection_token_hash TEXT NOT NULL DEFAULT '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_environment_id
          ON subscribers (environment_id)
          WHERE environment_id IS NOT NULL;
        INSERT INTO _sql_schema_migrations (id) VALUES (3);
      `);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "expected_websocket" }, { status: 426 });
    }

    const url = new URL(request.url);
    const routeId = routeIdFromTunnelPath(url.pathname);
    if (routeId === null) {
      return Response.json({ error: "invalid_tunnel_path" }, { status: 400 });
    }

    const environmentParam = url.searchParams.get("environmentId");
    const environmentId = parseEnvironmentId(environmentParam);
    if (environmentParam && !environmentId) {
      return Response.json({ error: "invalid_environment_id" }, { status: 400 });
    }

    const now = Date.now();
    this.purgeExpired(now);
    this.setRouteId(routeId);

    const attached = await this.reclaimOrCreate({
      environmentId,
      transport: "tunnel",
      targetBaseUrl: "",
      connectionToken: request.headers.get(ROUTER_HEADER_CONNECTION)
    });
    if (!attached.ok) {
      return Response.json({ error: attached.error }, { status: 409 });
    }
    await this.syncIndex();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [attached.subscriberId]);
    server.send(
      JSON.stringify({
        type: "hello",
        v: TUNNEL_PROTOCOL_VERSION,
        subscriberId: attached.subscriberId,
        routeId,
        forwardToken: attached.forwardToken,
        connectionToken: attached.connectionToken,
        ...(environmentId ? { environmentId } : {})
      })
    );

    const headers = new Headers();
    const selected = selectedTunnelProtocol(request.headers.get("Sec-WebSocket-Protocol"));
    if (selected) {
      headers.set("Sec-WebSocket-Protocol", selected);
    }
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === TUNNEL_PING || text === TUNNEL_PONG) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonMessage(text);
    } catch {
      return;
    }
    if (isTunnelHeartbeat(parsed)) {
      const [subscriberId] = this.ctx.getTags(ws);
      if (subscriberId) {
        this.extendSubscriber(subscriberId);
      }
      return;
    }
    if (!isTunnelResponse(parsed) && !isTunnelError(parsed)) {
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    if (isTunnelError(parsed)) {
      pending.reject(new Error(parsed.message || parsed.code));
      return;
    }
    pending.resolve(parsed);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.detachSocket(ws);
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.detachSocket(ws);
  }

  async register(
    targetBaseUrl: string,
    routeId: string,
    environmentId?: string | null,
    connectionToken?: string | null
  ): Promise<
    | {
        subscriberId: string;
        expiresIn: number;
        forwardToken: string;
        connectionToken: string;
      }
    | { error: "environment_in_use" }
  > {
    const normalized = validateTargetBaseUrl(targetBaseUrl);
    const now = Date.now();
    this.purgeExpired(now);
    this.setRouteId(routeId);

    const attached = await this.reclaimOrCreate({
      environmentId: environmentId || null,
      transport: "public",
      targetBaseUrl: normalized,
      connectionToken: connectionToken ?? null
    });
    if (!attached.ok) {
      return { error: attached.error };
    }
    await this.scheduleCleanup(now);
    await this.syncIndex();
    return {
      subscriberId: attached.subscriberId,
      expiresIn: SUBSCRIBER_TTL_MS / 1000,
      forwardToken: attached.forwardToken,
      connectionToken: attached.connectionToken
    };
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

  async verifyConnectionToken(subscriberId: string, token: string): Promise<boolean> {
    const row = this.lookupSubscriber(subscriberId);
    if (!row) {
      return false;
    }
    return connectionTokenMatches(token, row.connection_token_hash);
  }

  async deregister(subscriberId: string): Promise<boolean> {
    const now = Date.now();
    this.closeSockets(subscriberId);
    this.failPendingForSubscriber(subscriberId, new Error("subscriber_disconnected"));
    this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE id = ?", subscriberId);
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_bindings WHERE subscriber_id = ?",
      subscriberId
    );
    this.purgeExpired(now);
    const remaining = this.subscriberCount();
    if (remaining === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.scheduleCleanup(now);
    }
    await this.syncIndex();
    return true;
  }

  async bindOAuthState(
    subscriberId: string,
    state: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!state || state.length > OAUTH_STATE_MAX_LENGTH) {
      return { ok: false, error: "invalid_oauth_state" };
    }
    const now = Date.now();
    this.purgeExpired(now);
    const existing = this.lookupSubscriber(subscriberId);
    if (!existing) {
      return { ok: false, error: "subscriber_not_found" };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO oauth_bindings (state, subscriber_id, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(state) DO UPDATE SET
         subscriber_id = excluded.subscriber_id,
         expires_at = excluded.expires_at`,
      state,
      subscriberId,
      now + OAUTH_STATE_TTL_MS
    );
    return { ok: true };
  }

  async getActiveSubscribers(): Promise<Subscriber[]> {
    const now = Date.now();
    this.purgeExpired(now);
    const rows = this.ctx.storage.sql
      .exec<SubscriberRow>(
        `SELECT id, target_base_url, created_at, last_heartbeat_at, expires_at, transport, forward_token, connection_token_hash, environment_id
         FROM subscribers
         ORDER BY created_at ASC`
      )
      .toArray();
    return rows
      .filter((row) => row.transport !== "tunnel" || this.liveSocket(row.id) || Boolean(row.environment_id))
      .map(toSubscriber);
  }

  async fanOut(payload: IngressPayload): Promise<void> {
    const subscribers = this.deliverySubscribers();
    const body = bodyFromPayload(payload);
    await Promise.allSettled(
      subscribers.map((subscriber) => this.deliver(subscriber, payload, body, false))
    );
  }

  async proxyOAuth(payload: IngressPayload): Promise<ProxyResult> {
    const subscribers = this.deliverySubscribers();
    if (subscribers.length === 0) {
      return { kind: "error", status: 404, error: "route_not_found" };
    }

    const matched = await this.resolveOAuthSubscriber(payload.oauthState, subscribers);
    if (!matched) {
      return {
        kind: "error",
        status: subscribers.length > 1 ? 409 : 404,
        error: subscribers.length > 1 ? "oauth_unroutable" : "oauth_subscriber_not_found",
        message:
          subscribers.length > 1
            ? "OAuth callback could not be correlated to a single subscriber"
            : "OAuth subscriber is no longer connected"
      };
    }

    const body = bodyFromPayload(payload);
    if (body.byteLength > TUNNEL_MAX_BODY_BYTES && matched.transport === "tunnel") {
      return { kind: "error", status: 413, error: "request_too_large" };
    }

    try {
      const result = await this.deliver(matched, payload, body, true);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "subscriber_unreachable";
      return {
        kind: "error",
        status: 502,
        error: "subscriber_unreachable",
        message
      };
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.purgeExpired(now);
    await this.scheduleCleanup(now);
    await this.syncIndex();
  }

  private async deliver(
    subscriber: DeliverySubscriber,
    payload: IngressPayload,
    body: ArrayBuffer,
    capture: boolean
  ): Promise<ProxyResult> {
    const headers = buildForwardHeaders({
      incoming: headersFromPairs(payload.headerPairs),
      routeId: this.getRouteId() ?? "",
      subscriberId: subscriber.id,
      requestId: payload.requestId,
      publicHost: payload.publicHost,
      publicProto: payload.publicProto,
      clientIp: payload.clientIp,
      forwardToken: subscriber.forwardToken
    });
    this.touchSubscriber(subscriber.id);

    if (subscriber.transport === "tunnel") {
      return this.deliverOverTunnel(subscriber.id, payload, headers, body);
    }

    const response = await deliverToSubscriber({
      subscriber: {
        id: subscriber.id,
        transport: "public",
        targetBaseUrl: subscriber.targetBaseUrl,
        createdAt: 0,
        lastHeartbeatAt: 0,
        expiresAt: 0,
        environmentId: null
      },
      remainingPath: payload.remainingPath,
      search: payload.search,
      method: payload.method,
      body,
      headers
    });
    if (!capture) {
      return { kind: "proxy", status: response.status, headers: [] };
    }
    return captureSubscriberResponse(response);
  }

  private async deliverOverTunnel(
    subscriberId: string,
    payload: IngressPayload,
    headers: Headers,
    body: ArrayBuffer
  ): Promise<ProxyResult> {
    if (body.byteLength > TUNNEL_MAX_BODY_BYTES) {
      return { kind: "error", status: 413, error: "request_too_large" };
    }
    const message: TunnelRequestMessage = {
      type: "request",
      id: payload.requestId,
      method: payload.method,
      path: payload.remainingPath,
      search: payload.search,
      headers: serializeHeaders(headers),
      body: encodeBody(body)
    };
    const response = await this.sendAndWait(subscriberId, message);
    return {
      kind: "proxy",
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      bodyBase64: response.body
    };
  }

  private sendAndWait(
    subscriberId: string,
    message: TunnelRequestMessage
  ): Promise<TunnelResponseMessage> {
    return new Promise((resolve, reject) => {
      const ws = this.liveSocket(subscriberId);
      if (!ws) {
        reject(new Error("tunnel_disconnected"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error("tunnel_timeout"));
      }, DELIVERY_TIMEOUT_MS);
      this.pending.set(message.id, { subscriberId, resolve, reject, timer });
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.id);
        reject(error instanceof Error ? error : new Error("tunnel_send_failed"));
      }
    });
  }

  private async resolveOAuthSubscriber(
    state: string | null,
    subscribers: DeliverySubscriber[]
  ): Promise<DeliverySubscriber | null> {
    if (state) {
      const signed = this.env.DEV_ROUTER_SECRET
        ? await unwrapOAuthStateForRoute({
            operatorSecret: this.env.DEV_ROUTER_SECRET,
            routeSecret: await deriveRouteSecret(this.env.DEV_ROUTER_SECRET, this.getRouteId() ?? ""),
            state
          })
        : null;
      if (signed) {
        const routeId = this.getRouteId();
        if (routeId !== null && signed.route !== routeId) {
          return null;
        }
        return subscribers.find((item) => item.id === signed.sub) ?? null;
      }
      const bound = this.ctx.storage.sql
        .exec<{ subscriber_id: string }>(
          "SELECT subscriber_id FROM oauth_bindings WHERE state = ? AND expires_at > ?",
          state,
          Date.now()
        )
        .toArray()[0];
      if (bound) {
        return subscribers.find((item) => item.id === bound.subscriber_id) ?? null;
      }
    }
    if (subscribers.length === 1) {
      return subscribers[0];
    }
    return null;
  }

  private deliverySubscribers(): DeliverySubscriber[] {
    const now = Date.now();
    this.purgeExpired(now);
    const rows = this.ctx.storage.sql
      .exec<SubscriberRow>(
        `SELECT id, target_base_url, created_at, last_heartbeat_at, expires_at, transport, forward_token, connection_token_hash, environment_id
         FROM subscribers
         ORDER BY created_at ASC`
      )
      .toArray();
    return rows
      .filter((row) => row.transport !== "tunnel" || this.liveSocket(row.id))
      .map((row) => ({
        id: row.id,
        transport: row.transport === "tunnel" ? "tunnel" : "public",
        targetBaseUrl: row.target_base_url,
        forwardToken: this.ensureForwardToken(row)
      }));
  }

  private async reclaimOrCreate(options: {
    environmentId: string | null;
    transport: "public" | "tunnel";
    targetBaseUrl: string;
    connectionToken?: string | null;
  }): Promise<
    | {
        ok: true;
        subscriberId: string;
        forwardToken: string;
        connectionToken: string;
      }
    | { ok: false; error: "environment_in_use" }
  > {
    const now = Date.now();
    const existing = options.environmentId
      ? this.lookupSubscriberByEnvironment(options.environmentId)
      : undefined;

    const connectionToken = randomConnectionToken();
    const connectionTokenHash = await hashConnectionToken(connectionToken);

    if (existing) {
      if (this.subscriberIsLive(existing)) {
        const proof = options.connectionToken ?? "";
        if (!(await connectionTokenMatches(proof, existing.connection_token_hash))) {
          return { ok: false, error: "environment_in_use" };
        }
      }
      this.closeSockets(existing.id);
      this.failPendingForSubscriber(existing.id, new Error("subscriber_replaced"));
      const forwardToken = this.ensureForwardToken(existing);
      this.ctx.storage.sql.exec(
        `UPDATE subscribers
         SET transport = ?, target_base_url = ?, connection_token_hash = ?,
             last_heartbeat_at = ?, expires_at = ?, environment_id = ?
         WHERE id = ?`,
        options.transport,
        options.targetBaseUrl,
        connectionTokenHash,
        now,
        now + SUBSCRIBER_TTL_MS,
        options.environmentId,
        existing.id
      );
      return {
        ok: true,
        subscriberId: existing.id,
        forwardToken,
        connectionToken
      };
    }

    const subscriberId = `sub_${randomHex(6)}`;
    const forwardToken = `ft_${randomHex(18)}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO subscribers
        (id, target_base_url, created_at, last_heartbeat_at, expires_at, transport, forward_token, connection_token_hash, environment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      subscriberId,
      options.targetBaseUrl,
      now,
      now,
      now + SUBSCRIBER_TTL_MS,
      options.transport,
      forwardToken,
      connectionTokenHash,
      options.environmentId
    );
    return { ok: true, subscriberId, forwardToken, connectionToken };
  }

  private subscriberIsLive(row: SubscriberRow): boolean {
    if (row.transport === "tunnel") {
      return this.ctx.getWebSockets(row.id).length > 0;
    }
    return true;
  }

  private lookupSubscriberByEnvironment(environmentId: string): SubscriberRow | undefined {
    return this.ctx.storage.sql
      .exec<SubscriberRow>(
        `SELECT id, target_base_url, created_at, last_heartbeat_at, expires_at, transport, forward_token, connection_token_hash, environment_id
         FROM subscribers WHERE environment_id = ?`,
        environmentId
      )
      .toArray()[0];
  }

  private lookupSubscriber(subscriberId: string): SubscriberRow | undefined {
    return this.ctx.storage.sql
      .exec<SubscriberRow>(
        `SELECT id, target_base_url, created_at, last_heartbeat_at, expires_at, transport, forward_token, connection_token_hash, environment_id
         FROM subscribers WHERE id = ?`,
        subscriberId
      )
      .toArray()[0];
  }

  private ensureForwardToken(row: SubscriberRow): string {
    if (row.forward_token) {
      return row.forward_token;
    }
    const token = `ft_${randomHex(18)}`;
    this.ctx.storage.sql.exec(
      "UPDATE subscribers SET forward_token = ? WHERE id = ?",
      token,
      row.id
    );
    return token;
  }

  private touchSubscriber(subscriberId: string): void {
    this.extendSubscriber(subscriberId);
  }

  private extendSubscriber(subscriberId: string): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE subscribers
       SET last_heartbeat_at = ?, expires_at = ?
       WHERE id = ?`,
      now,
      now + SUBSCRIBER_TTL_MS,
      subscriberId
    );
  }

  private async detachSocket(ws: WebSocket): Promise<void> {
    const [subscriberId] = this.ctx.getTags(ws);
    if (!subscriberId) {
      return;
    }
    this.failPendingForSubscriber(subscriberId, new Error("tunnel_disconnected"));
    const row = this.lookupSubscriber(subscriberId);
    if (row?.environment_id) {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE subscribers
         SET last_heartbeat_at = ?, expires_at = ?
         WHERE id = ?`,
        now,
        now + SUBSCRIBER_TTL_MS,
        subscriberId
      );
      await this.scheduleCleanup(now);
      await this.syncIndex();
      return;
    }
    this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE id = ?", subscriberId);
    this.ctx.storage.sql.exec(
      "DELETE FROM oauth_bindings WHERE subscriber_id = ?",
      subscriberId
    );
    await this.syncIndex();
  }

  private closeSockets(subscriberId: string): void {
    for (const ws of this.ctx.getWebSockets(subscriberId)) {
      try {
        ws.close(1000, "deregistered");
      } catch {
        // Already closing.
      }
    }
  }

  private liveSocket(subscriberId: string): WebSocket | undefined {
    return this.ctx.getWebSockets(subscriberId).find((ws) => ws.readyState === 1);
  }

  private failPendingForSubscriber(subscriberId: string, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.subscriberId !== subscriberId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private purgeExpired(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM subscribers WHERE transport = 'public' AND expires_at <= ?",
      now
    );
    const expiredTunnels = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM subscribers WHERE transport = 'tunnel' AND expires_at <= ?",
        now
      )
      .toArray();
    for (const row of expiredTunnels) {
      if (this.liveSocket(row.id) || this.ctx.getWebSockets(row.id).length > 0) {
        this.extendSubscriber(row.id);
        continue;
      }
      this.failPendingForSubscriber(row.id, new Error("tunnel_disconnected"));
      this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE id = ?", row.id);
      this.ctx.storage.sql.exec("DELETE FROM oauth_bindings WHERE subscriber_id = ?", row.id);
    }
    this.ctx.storage.sql.exec("DELETE FROM oauth_bindings WHERE expires_at <= ?", now);
    this.purgeDisconnectedTunnels();
    this.expireStaleTunnels(now);
  }

  private purgeDisconnectedTunnels(): void {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; environment_id: string | null }>(
        "SELECT id, environment_id FROM subscribers WHERE transport = 'tunnel'"
      )
      .toArray();
    for (const row of rows) {
      if (this.liveSocket(row.id) || this.ctx.getWebSockets(row.id).length > 0) {
        continue;
      }
      if (row.environment_id) {
        continue;
      }
      this.failPendingForSubscriber(row.id, new Error("tunnel_disconnected"));
      this.ctx.storage.sql.exec("DELETE FROM subscribers WHERE id = ?", row.id);
      this.ctx.storage.sql.exec("DELETE FROM oauth_bindings WHERE subscriber_id = ?", row.id);
    }
  }

  private expireStaleTunnels(now: number): void {
    const rows = this.ctx.storage.sql
      .exec<SubscriberRow>(
        `SELECT id, target_base_url, created_at, last_heartbeat_at, expires_at, transport, forward_token, connection_token_hash, environment_id
         FROM subscribers WHERE transport = 'tunnel'`
      )
      .toArray();
    for (const row of rows) {
      const ws = this.liveSocket(row.id);
      if (!ws) {
        continue;
      }
      let lastSeen = row.last_heartbeat_at || row.created_at;
      try {
        const auto = this.ctx.getWebSocketAutoResponseTimestamp(ws);
        if (auto) {
          lastSeen = Math.max(lastSeen, auto.getTime());
        }
      } catch {
        // Miniflare may not expose auto-response timestamps.
      }
      if (now - lastSeen <= TUNNEL_STALE_MS) {
        continue;
      }
      try {
        ws.close(4000, "stale_tunnel");
      } catch {
        // Already closing.
      }
    }
  }

  private subscriberCount(): number {
    return this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM subscribers")
      .one().count;
  }

  private setRouteId(routeId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO meta (key, value) VALUES ('route_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      routeId
    );
  }

  private getRouteId(): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'route_id'")
      .toArray()[0];
    return row ? row.value : null;
  }

  private async syncIndex(): Promise<void> {
    const routeId = this.getRouteId();
    if (routeId === null) {
      return;
    }
    const index = this.env.ROUTER_INDEX.getByName(durableObjectNameForIndex());
    if (this.subscriberCount() === 0) {
      await index.removeRoute(routeId);
      return;
    }
    await index.addRoute(routeId);
  }

  private async scheduleCleanup(now: number): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT MIN(expires_at) as expires_at FROM subscribers"
      )
      .toArray()[0];
    const hasLiveTunnels = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM subscribers WHERE transport = 'tunnel'"
      )
      .one().count;
    const candidates = [next?.expires_at, hasLiveTunnels > 0 ? now + 30_000 : undefined].filter(
      (value): value is number => typeof value === "number" && value > 0
    );
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now + 1_000));
  }
}

function toSubscriber(row: SubscriberRow): Subscriber {
  const transport = row.transport === "tunnel" ? "tunnel" : "public";
  return {
    id: row.id,
    transport,
    targetBaseUrl: transport === "tunnel" ? "reverse-tunnel" : row.target_base_url,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    expiresAt: row.expires_at,
    environmentId: row.environment_id
  };
}

function bodyFromPayload(payload: IngressPayload): ArrayBuffer {
  const bytes = decodeBody(payload.bodyBase64);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function parseEnvironmentId(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return isAllowedEnvironmentId(value) ? value : null;
}

function selectedTunnelProtocol(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(",")) {
    const token = part.trim();
    if (token.startsWith(TUNNEL_SUBPROTOCOL_PREFIX)) {
      return token;
    }
  }
  return undefined;
}
