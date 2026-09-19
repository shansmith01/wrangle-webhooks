import { deriveRouteSecret, matchJoinCredential } from "./credentials";
import {
  clientIpFromRequest,
  type ConnectionLogEventInput
} from "./connection-log";
import {
  readManagementSecret,
  requireManagementAuth,
  unauthorizedManagementResponse
} from "./management-auth";
import { validateOAuthCallbackPath } from "./oauth-callback-path";
import { routerIndexStub } from "./router-index";
import { durableObjectNameForRoute, isAllowedEnvironmentId, isAllowedRouteId } from "./route-id";
import { TargetBaseUrlError, validateTargetBaseUrl } from "./target-base-url";
import { routeIdFromTunnelPath } from "./tunnel-protocol";

const REGISTER = /^\/_router\/routes\/([^/]+)\/subscribers$/;
const HEARTBEAT =
  /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)\/heartbeat$/;
const DEREGISTER = /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)$/;
const OAUTH_BIND = /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)\/oauth-states$/;
const CREDENTIAL = /^\/_router\/routes\/([^/]+)\/credential$/;
const NAMED_OAUTH_CALLBACK_PATHS = /^\/_router\/routes\/([^/]+)\/oauth-callback-paths$/;
const DEFAULT_REGISTER = /^\/_router\/subscribers$/;
const DEFAULT_HEARTBEAT = /^\/_router\/subscribers\/([^/]+)\/heartbeat$/;
const DEFAULT_DEREGISTER = /^\/_router\/subscribers\/([^/]+)$/;
const DEFAULT_OAUTH_BIND = /^\/_router\/subscribers\/([^/]+)\/oauth-states$/;
const DEFAULT_CREDENTIAL = /^\/_router\/credential$/;
const DEFAULT_OAUTH_CALLBACK_PATHS = /^\/_router\/oauth-callback-paths$/;
const DEFAULT_TUNNEL = /^\/_router\/tunnel$/;
const NAMED_TUNNEL = /^\/_router\/routes\/([^/]+)\/tunnel$/;

/** Handle `/_router/*` management, credential, and tunnel upgrade requests. */
export async function handleManagement(
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

  if (DEFAULT_OAUTH_CALLBACK_PATHS.test(url.pathname)) {
    return handleOAuthCallbackPaths(request, env, "");
  }
  const namedOAuthCallbackPaths = url.pathname.match(NAMED_OAUTH_CALLBACK_PATHS);
  if (namedOAuthCallbackPaths) {
    return handleOAuthCallbackPaths(
      request,
      env,
      decodeURIComponent(namedOAuthCallbackPaths[1])
    );
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
    return unauthorizedManagementResponse();
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
  if (role) {
    return null;
  }
  await recordRejectedJoin(request, env, routeId);
  return unauthorizedManagementResponse();
}

/** Record an unauthenticated or invalid-credential join attempt in the connection audit log. */
async function recordRejectedJoin(request: Request, env: Env, routeId: string): Promise<void> {
  const url = new URL(request.url);
  const environmentParam = url.searchParams.get("environmentId");
  const event: ConnectionLogEventInput = {
    action: "rejected",
    reason: "unauthorized",
    routeId,
    environmentId:
      environmentParam && isAllowedEnvironmentId(environmentParam) ? environmentParam : null,
    clientIp: clientIpFromRequest(request)
  };
  await routerIndexStub(env).recordConnectionEvents([event]);
}

async function authorizeSubscriber(
  request: Request,
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response | null> {
  const bearer = readManagementSecret(request);
  if (!bearer) {
    return unauthorizedManagementResponse();
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
  return unauthorizedManagementResponse();
}

async function mintRouteCredential(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response> {
  if (!requireManagementAuth(request, env.DEV_ROUTER_SECRET)) {
    return unauthorizedManagementResponse();
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

  const proofToken =
    payload &&
    typeof payload === "object" &&
    "connectionToken" in payload &&
    typeof payload.connectionToken === "string"
      ? payload.connectionToken
      : null;

  const stub = env.ROUTE.getByName(durableObjectNameForRoute(routeId));
  const result = await stub.register(
    targetBaseUrl,
    routeId,
    environmentId ?? null,
    proofToken,
    clientIpFromRequest(request)
  );
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: 409 });
  }
  await routerIndexStub(env).addRoute(routeId);
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
    await routerIndexStub(env).removeRoute(routeId);
  }
  return new Response(null, { status: 204 });
}

/**
 * Operator-only CRUD for admin-allowlisted OAuth callback remaining paths.
 * Minted route join tokens cannot expand the reverse-proxy surface.
 */
async function handleOAuthCallbackPaths(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response> {
  if (!requireManagementAuth(request, env.DEV_ROUTER_SECRET)) {
    return unauthorizedManagementResponse();
  }
  if (!isAllowedRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const index = routerIndexStub(env);

  if (request.method === "GET") {
    const paths = await index.listOAuthCallbackPaths(routeId);
    return Response.json({ routeId, paths });
  }

  if (request.method === "PUT") {
    const path = await readOAuthCallbackPathBody(request);
    if (path === null) {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!validateOAuthCallbackPath(path)) {
      return Response.json({ error: "invalid_oauth_callback_path" }, { status: 400 });
    }
    const row = await index.addOAuthCallbackPath(routeId, path);
    if (!row) {
      return Response.json({ error: "invalid_oauth_callback_path" }, { status: 400 });
    }
    return Response.json({
      routeId: row.routeId,
      path: row.remainingPath,
      createdAt: row.createdAt
    });
  }

  if (request.method === "DELETE") {
    const path =
      (await readOAuthCallbackPathBody(request)) ??
      new URL(request.url).searchParams.get("path");
    if (!path || !validateOAuthCallbackPath(path)) {
      return Response.json({ error: "invalid_oauth_callback_path" }, { status: 400 });
    }
    const removed = await index.removeOAuthCallbackPath(routeId, path);
    if (!removed) {
      return Response.json({ error: "oauth_callback_path_not_found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

async function readOAuthCallbackPathBody(request: Request): Promise<string | null> {
  if (request.method === "DELETE" && !request.headers.get("content-type")) {
    return null;
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }
  if (
    payload &&
    typeof payload === "object" &&
    "path" in payload &&
    typeof payload.path === "string"
  ) {
    return payload.path;
  }
  return null;
}
