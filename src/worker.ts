import { requireManagementAuth, unauthorized } from "./auth";
import { RouteDurableObject } from "./durable-object";
import { fanOutToSubscribers } from "./forward";
import {
  TargetBaseUrlError,
  isValidRouteId,
  remainingPathFromPublicUrl,
  validateTargetBaseUrl
} from "./shared";

export { RouteDurableObject };

const REGISTER = /^\/_router\/routes\/([^/]+)\/subscribers$/;
const HEARTBEAT =
  /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)\/heartbeat$/;
const DEREGISTER = /^\/_router\/routes\/([^/]+)\/subscribers\/([^/]+)$/;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
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
  if (!requireManagementAuth(request, env.DEV_ROUTER_SECRET)) {
    return unauthorized();
  }

  const registerMatch = url.pathname.match(REGISTER);
  if (registerMatch && request.method === "POST") {
    return registerSubscriber(request, env, decodeURIComponent(registerMatch[1]));
  }

  const heartbeatMatch = url.pathname.match(HEARTBEAT);
  if (heartbeatMatch && request.method === "POST") {
    return heartbeatSubscriber(
      env,
      decodeURIComponent(heartbeatMatch[1]),
      decodeURIComponent(heartbeatMatch[2])
    );
  }

  const deregisterMatch = url.pathname.match(DEREGISTER);
  if (deregisterMatch && request.method === "DELETE") {
    return deregisterSubscriber(
      env,
      decodeURIComponent(deregisterMatch[1]),
      decodeURIComponent(deregisterMatch[2])
    );
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function registerSubscriber(
  request: Request,
  env: Env,
  routeId: string
): Promise<Response> {
  if (!isValidRouteId(routeId)) {
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

  const stub = env.ROUTE.getByName(routeId);
  const result = await stub.register(targetBaseUrl);
  return Response.json({
    subscriberId: result.subscriberId,
    routeId,
    expiresIn: result.expiresIn
  });
}

async function heartbeatSubscriber(
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response> {
  if (!isValidRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const stub = env.ROUTE.getByName(routeId);
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

async function deregisterSubscriber(
  env: Env,
  routeId: string,
  subscriberId: string
): Promise<Response> {
  if (!isValidRouteId(routeId)) {
    return Response.json({ error: "invalid_route_id" }, { status: 400 });
  }
  const stub = env.ROUTE.getByName(routeId);
  await stub.deregister(subscriberId);
  return new Response(null, { status: 204 });
}

async function handlePublic(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  const segments = url.pathname.split("/").filter(Boolean);
  const routeId = segments[0];
  if (!routeId || !isValidRouteId(routeId)) {
    return Response.json({ error: "route_not_found" }, { status: 404 });
  }

  const stub = env.ROUTE.getByName(routeId);
  const subscribers = await stub.getActiveSubscribers();
  if (subscribers.length === 0) {
    return Response.json({ error: "route_not_found" }, { status: 404 });
  }

  const remainingPath = remainingPathFromPublicUrl(url.pathname, routeId);
  const body = await request.arrayBuffer();
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const publicHost = url.host;
  const publicProto = url.protocol.replace(":", "") || "https";
  const clientIp = request.headers.get("CF-Connecting-IP");

  ctx.waitUntil(
    fanOutToSubscribers({
      subscribers,
      remainingPath,
      search: url.search,
      method: request.method,
      body,
      incomingHeaders: request.headers,
      routeId,
      requestId,
      publicHost,
      publicProto,
      clientIp,
      routerSecret: env.DEV_ROUTER_SECRET
    })
  );

  return Response.json({ accepted: true }, { status: 202 });
}
