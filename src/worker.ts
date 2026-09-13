import { readManagementSecret, requireManagementAuth, unauthorized } from "./auth";
import { deriveRouteSecret, matchJoinCredential } from "./credentials";
import { dashboardHtml, dashboardStatus, type DashboardRoute } from "./dashboard";
import { RouteDurableObject } from "./durable-object";
import {
  classifyDelivery,
  parseFormBody,
  readOAuthState
} from "./oauth-state";
import { RouterIndex } from "./router-index";
import {
  TargetBaseUrlError,
  durableObjectNameForIndex,
  durableObjectNameForRoute,
  isAllowedEnvironmentId,
  isAllowedRouteId,
  isValidRouteId,
  remainingPathFromPublicUrl,
  validateTargetBaseUrl
} from "./shared";
import {
  decodeBody,
  encodeBody,
  routeIdFromTunnelPath,
  serializeHeaders
} from "./tunnel-protocol";
import type { IngressPayload } from "./types";

export { RouteDurableObject, RouterIndex };

const REGISTER = /^\/_router\/routes\/([^/]+)\/subscribers$/;
const HEARTBEAT =
  /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)\/heartbeat$/;
const DEREGISTER = /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)$/;
const OAUTH_BIND = /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)\/oauth-states$/;
const CREDENTIAL = /^\/_router\/routes\/([^/]+)\/credential$/;
const DEFAULT_REGISTER = /^\/_router\/subscribers$/;
const DEFAULT_HEARTBEAT = /^\/_router\/subscribers\/([^/]+)\/heartbeat$/;
const DEFAULT_DEREGISTER = /^\/_router\/subscribers\/([^/]+)$/;
const DEFAULT_OAUTH_BIND = /^\/_router\/subscribers\/([^/]+)\/oauth-states$/;
const DEFAULT_CREDENTIAL = /^\/_router\/credential$/;
const DEFAULT_TUNNEL = /^\/_router\/tunnel$/;
const NAMED_TUNNEL = /^\/_router\/routes\/([^/]+)\/tunnel$/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/dashboard" || url.pathname === "/dashboard.json") {
      return handleDashboard(request, env, url.pathname);
    }
    if (url.pathname === "/_router" || url.pathname.startsWith("/_router/")) {
      return handleManagement(request, env, url);
    }
    return handlePublic(request, env, ctx, url);
  }
} satisfies ExportedHandler<Env>;

async function handleManagement(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (!env.DEV_ROUTER_SECRET) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const namedTunnel = url.pathname.match(NAMED_TUNNEL);
  if (namedTunnel) {
    const denied = await authorizeJoin(request, env, decodeURIComponent(namedTunnel[1]));
    if (denied) {
      return denied;
    }
    return handleTunnel(request, env, decodeURIComponent(namedTunnel[1]));
  }
  if (DEFAULT_TUNNEL.test(url.pathname)) {
    const denied = await authorizeJoin(request, env, "");
    if (denied) {
      return denied;
    }
    return handleTunnel(request, env, "");
  }

  const defaultCredential = DEFAULT_CREDENTIAL.test(url.pathname);
  if (defaultCredential && request.method === "GET") {
    return mintRouteCredential(request, env, "");
  }
  const namedCredential = url.pathname.match(CREDENTIAL);
  if (namedCredential && request.method === "GET") {
    return mintRouteCredential(request, env, decodeURIComponent(namedCredential[1]));
  }

  const defaultRegister = url.pathname.match(DEFAULT_REGISTER);
  if (defaultRegister && request.method === "POST") {
    const denied = await authorizeJoin(request, env, "");
    if (denied) {
      return denied;
    }
    return registerSubscriber(request, env, "");
  }

  const defaultHeartbeat = url.pathname.match(DEFAULT_HEARTBEAT);
  if (defaultHeartbeat && request.method === "POST") {
    const denied = await authorizeSubscriber(
      request,
      env,
      "",
      decodeURIComponent(defaultHeartbeat[1])
    );
    if (denied) {
      return denied;
    }
    return heartbeatSubscriber(env, "", decodeURIComponent(defaultHeartbeat[1]));
  }

  const defaultOAuthBind = url.pathname.match(DEFAULT_OAUTH_BIND);
  if (defaultOAuthBind && request.method === "POST") {
    const denied = await authorizeSubscriber(
      request,
      env,
      "",
      decodeURIComponent(defaultOAuthBind[1])
    );
    if (denied) {
      return denied;
    }
    return bindOAuthState(request, env, "", decodeURIComponent(defaultOAuthBind[1]));
  }

  const registerMatch = url.pathname.match(REGISTER);
  if (registerMatch && request.method === "POST") {
    const routeId = decodeURIComponent(registerMatch[1]);
    const denied = await authorizeJoin(request, env, routeId);
    if (denied) {
      return denied;
    }
    return registerSubscriber(request, env, routeId);
  }

  const heartbeatMatch = url.pathname.match(HEARTBEAT);
  if (heartbeatMatch && request.method === "POST") {
    const routeId = decodeURIComponent(heartbeatMatch[1]);
    const subscriberId = decodeURIComponent(heartbeatMatch[2]);
    const denied = await authorizeSubscriber(request, env, routeId, subscriberId);
    if (denied) {
      return denied;
    }
    return heartbeatSubscriber(env, routeId, subscriberId);
  }

  const oauthBindMatch = url.pathname.match(OAUTH_BIND);
  if (oauthBindMatch && request.method === "POST") {
    const routeId = decodeURIComponent(oauthBindMatch[1]);
    const subscriberId = decodeURIComponent(oauthBindMatch[2]);
    const denied = await authorizeSubscriber(request, env, routeId, subscriberId);
    if (denied) {
      return denied;
    }
    return bindOAuthState(request, env, routeId, subscriberId);
  }

  const defaultDeregister = url.pathname.match(DEFAULT_DEREGISTER);
  if (defaultDeregister && request.method === "DELETE") {
    const subscriberId = decodeURIComponent(defaultDeregister[1]);
    const denied = await authorizeSubscriber(request, env, "", subscriberId);
    if (denied) {
      return denied;
    }
    return deregisterSubscriber(env, "", subscriberId);
  }

  const deregisterMatch = url.pathname.match(DEREGISTER);
  if (deregisterMatch && request.method === "DELETE") {
    const routeId = decodeURIComponent(deregisterMatch[1]);
    const subscriberId = decodeURIComponent(deregisterMatch[2]);
    const denied = await authorizeSubscriber(request, env, routeId, subscriberId);
    if (denied) {
      return denied;
    }
    return deregisterSubscriber(env, routeId, subscriberId);
  }

  if (!requireManagementAuth(request, env.DEV_ROUTER_SECRET) && !readManagementSecret(request)) {
    return unauthorized();
  }
  return Response.json({ error: "not_found" }, { status: 404 });
}

async function authorizeJoin(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response | null> {
  const role = await matchJoinCredential(
    readManagementSecret(request),
    env.DEV_ROUTER_SECRET,
    routeId
  );
  return role ? null : unauthorized();
}

async function authorizeSubscriber(
  request: Request,
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response | null> {
  const bearer = readManagementSecret(request);
  if (!bearer) {
    return unauthorized();
  }
  if (await matchJoinCredential(bearer, env.DEV_ROUTER_SECRET, routeId) === "operator") {
    return null;
  }
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  if (await stub.verifyConnectionToken(subscriberId, bearer)) {
    return null;
  }
  return unauthorized();
}

async function mintRouteCredential(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response> {
  if (!requireManagementAuth(request, env.DEV_ROUTER_SECRET)) {
    return unauthorized();
  }
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const secret = await deriveRouteSecret(env.DEV_ROUTER_SECRET, routeId);
  return Response.json({ routeId, secret });
}

async function handleTunnel(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response> {
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "expected_websocket" }, { status: 426 });
  }
  if (routeIdFromTunnelPath(new URL(request.url).pathname) === null) {
    return Response.json({ error: "invalid_tunnel_path" }, { status: 400 });
  }
  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  return stub.fetch(request);
}

async function registerSubscriber(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response> {
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const targetBaseUrl =
    payload &&
    typeof payload === "object" &&
    "targetBaseUrl" in payload &&
    typeof payload.targetBaseUrl === "string"
      ? payload.targetBaseUrl
      : null;
  if (!targetBaseUrl) {
    return Response.json({ error: "target_base_url_required" }, { status: 400 });
  }

  try {
    validateTargetBaseUrl(targetBaseUrl);
  } catch (error) {
    if (error instanceof TargetBaseUrlError) {
      return Response.json(
        { error: "invalid_target_base_url", message: error.message },
        { status: 400 }
      );
    }
    throw error;
  }

  const environmentId =
    payload &&
    typeof payload === "object" &&
    "environmentId" in payload &&
    typeof payload.environmentId === "string"
      ? payload.environmentId
      : undefined;
  if (environmentId && !isAllowedEnvironmentId(environmentId)) {
    return Response.json({ error: "invalid_environment_id" }, { status: 400 });
  }

  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  const result = await stub.register(targetBaseUrl, routeId, environmentId ?? null);
  await indexStub(env).addRoute(routeId);
  return Response.json({
    subscriberId: result.subscriberId,
    routeId,
    expiresIn: result.expiresIn,
    forwardToken: result.forwardToken,
    connectionToken: result.connectionToken
  });
}

async function heartbeatSubscriber(
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response> {
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  const result = await stub.heartbeat(subscriberId);
  if (!result) {
    return Response.json({ error: "subscriber_not_found" }, { status: 404 });
  }
  return Response.json({
    subscriberId,
    routeId,
    expiresIn: result.expiresIn
  });
}

async function bindOAuthState(
  request: Request,
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response> {
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const state =
    payload &&
    typeof payload === "object" &&
    "state" in payload &&
    typeof payload.state === "string"
      ? payload.state
      : "";
  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  const result = await stub.bindOAuthState(subscriberId, state);
  if (!result.ok) {
    const status = result.error === "subscriber_not_found" ? 404 : 400;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json({ ok: true });
}

async function deregisterSubscriber(
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response> {
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  await stub.deregister(subscriberId);
  const remaining = await stub.getActiveSubscribers();
  if (remaining.length === 0) {
    await indexStub(env).removeRoute(routeId);
  }
  return new Response(null, { status: 204 });
}

async function handleDashboard(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const routes = await loadDashboardRoutes(env);
  const status = dashboardStatus(Boolean(env.DEV_ROUTER_SECRET), routes);
  if (pathname === "/dashboard.json") {
    return Response.json(status, {
      headers: { "Cache-Control": "no-store" }
    });
  }
  return new Response(dashboardHtml(status), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function loadDashboardRoutes(env: Env): Promise<DashboardRoute[]> {
  const routeIds = await indexStub(env).listRoutes();
  const routes: DashboardRoute[] = [];
  for (const routeId of routeIds) {
    const subscribers = await env.ROUTE.getByName(
      durableObjectNameForRoute(routeId)
    ).getActiveSubscribers();
    if (subscribers.length === 0) {
      await indexStub(env).removeRoute(routeId);
      continue;
    }
    routes.push({
      routeId,
      publicPath: routeId === "" ? "/*" : `/${routeId}/*`,
      subscribers
    });
  }
  return routes;
}

function indexStub(env: Env): DurableObjectStub<RouterIndex> {
  return env.ROUTER_INDEX.getByName(durableObjectNameForIndex());
}

async function handlePublic(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  const resolved = await resolvePublicRoute(env, url);
  if (!resolved) {
    return Response.json({ error: "route_not_found" }, { status: 404 });
  }

  const body = await request.arrayBuffer();
  const form = parseFormBody(request.headers.get("content-type"), body);
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const payload: IngressPayload = {
    remainingPath: resolved.remainingPath,
    search: url.search,
    method: request.method,
    headerPairs: serializeHeaders(request.headers),
    bodyBase64: encodeBody(body),
    requestId,
    publicHost: url.host,
    publicProto: url.protocol.replace(":", "") || "https",
    clientIp: request.headers.get("CF-Connecting-IP"),
    oauthState: readOAuthState(url.search, form)
  };

  const stub = env.ROUTE.getByName(durableObjectNameForRoute(resolved.routeId));
  const delivery = classifyDelivery({
    remainingPath: resolved.remainingPath,
    search: url.search,
    form
  });

  if (delivery === "oauth") {
    return proxyResultToResponse(await stub.proxyOAuth(payload));
  }

  ctx.waitUntil(stub.fanOut(payload));
  return Response.json({ accepted: true }, { status: 202 });
}

function proxyResultToResponse(result: {
  kind: "proxy" | "error";
  status: number;
  headers?: string[][];
  bodyBase64?: string;
  error?: string;
  message?: string;
}): Response {
  if (result.kind === "error") {
    return Response.json(
      { error: result.error, ...(result.message ? { message: result.message } : {}) },
      { status: result.status }
    );
  }
  const headers = new Headers();
  for (const pair of result.headers ?? []) {
    const name = pair[0];
    const value = pair[1];
    if (name && value !== undefined) {
      headers.append(name, value);
    }
  }
  const body = decodeBody(result.bodyBase64);
  return new Response(body, {
    status: result.status,
    headers
  });
}

async function resolvePublicRoute(
  env: Env,
  url: URL
): Promise<{
  routeId: string;
  remainingPath: string;
  subscribers: Awaited<ReturnType<RouteDurableObject["getActiveSubscribers"]>>;
} | null> {
  const segments = url.pathname.split("/").filter(Boolean);
  const candidate = segments[0];
  if (candidate && isValidRouteId(candidate)) {
    const named = await env.ROUTE.getByName(
      durableObjectNameForRoute(candidate)
    ).getActiveSubscribers();
    if (named.length > 0) {
      return {
        routeId: candidate,
        remainingPath: remainingPathFromPublicUrl(url.pathname, candidate),
        subscribers: named
      };
    }
  }

  const defaults = await env.ROUTE.getByName(
    durableObjectNameForRoute("")
  ).getActiveSubscribers();
  if (defaults.length > 0) {
    return {
      routeId: "",
      remainingPath: remainingPathFromPublicUrl(url.pathname, ""),
      subscribers: defaults
    };
  }

  return null;
}
