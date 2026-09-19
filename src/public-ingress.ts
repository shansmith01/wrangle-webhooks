import { RouteDurableObject } from "./durable-object";
import {
  inboundBodyBytes,
  type InboundLogEventInput,
  type InboundLogKind
} from "./inbound-log";
import { readCappedIngressBody } from "./ingress-body";
import { publicPathHasDotDotSegment, remainingPathFromPublicUrl } from "./ingress-urls";
import {
  classifyDelivery,
  parseFormBody,
  readOAuthState,
  type DeliveryClass
} from "./oauth-state";
import { durableObjectNameForRoute, isValidRouteId } from "./route-id";
import { routerIndexStub } from "./router-index";
import { isScannerProbePath } from "./scanner-probe";
import {
  decodeBody,
  encodeBody,
  serializeHeaders
} from "./tunnel-protocol";
import type { IngressPayload } from "./dev-router-types";

/** Accept a public ingress request and fan it out, or proxy an OAuth callback. */
export async function handlePublicIngress(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  if (isScannerProbePath(url.pathname) || publicPathHasDotDotSegment(url.pathname)) {
    return scannerProbeNotFound();
  }

  const resolved = await resolvePublicRoute(env, url);
  if (!resolved) {
    const requestId = newPublicRequestId();
    await recordPublicInboundLog(env, {
      id: requestId,
      method: request.method,
      routeId: null,
      remainingPath: url.pathname || "/",
      search: url.search,
      kind: inboundLogKind(
        classifyDelivery({
          remainingPath: url.pathname || "/",
          search: url.search,
          form: null,
          method: request.method,
          allowedCallbackPaths: []
        })
      ),
      result: "rejected",
      status: 404,
      error: "route_not_found",
      subscriberCount: 0,
      bodyBytes: inboundBodyBytes(request)
    });
    return Response.json({ error: "route_not_found" }, { status: 404 });
  }

  if (publicPathHasDotDotSegment(resolved.remainingPath)) {
    return scannerProbeNotFound();
  }

  const allowedCallbackPaths = await routerIndexStub(env).listOAuthCallbackPaths(
    resolved.routeId
  );

  const capped = await readCappedIngressBody(request);
  if (!capped.ok) {
    const requestId = newPublicRequestId();
    await recordPublicInboundLog(env, {
      id: requestId,
      method: request.method,
      routeId: resolved.routeId,
      remainingPath: resolved.remainingPath,
      search: url.search,
      kind: inboundLogKind(
        classifyDelivery({
          remainingPath: resolved.remainingPath,
          search: url.search,
          form: null,
          method: request.method,
          allowedCallbackPaths
        })
      ),
      result: "rejected",
      status: 413,
      error: "request_too_large",
      subscriberCount: resolved.subscribers.length,
      bodyBytes: capped.bodyBytes
    });
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  const body = capped.body;
  const form = parseFormBody(request.headers.get("content-type"), body);
  const requestId = newPublicRequestId();
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
    form,
    method: request.method,
    allowedCallbackPaths
  });
  const kind = inboundLogKind(delivery);

  if (delivery === "oauth_callback_not_registered") {
    await recordPublicInboundLog(env, {
      id: requestId,
      method: request.method,
      routeId: resolved.routeId,
      remainingPath: resolved.remainingPath,
      search: url.search,
      kind,
      result: "rejected",
      status: 404,
      error: "oauth_callback_not_registered",
      subscriberCount: resolved.subscribers.length,
      bodyBytes: inboundBodyBytes(request, body)
    });
    return Response.json({ error: "oauth_callback_not_registered" }, { status: 404 });
  }

  if (delivery === "oauth_callback_incomplete") {
    await recordPublicInboundLog(env, {
      id: requestId,
      method: request.method,
      routeId: resolved.routeId,
      remainingPath: resolved.remainingPath,
      search: url.search,
      kind,
      result: "rejected",
      status: 404,
      error: "oauth_callback_incomplete",
      subscriberCount: resolved.subscribers.length,
      bodyBytes: inboundBodyBytes(request, body)
    });
    return Response.json({ error: "oauth_callback_incomplete" }, { status: 404 });
  }

  if (delivery === "oauth_method_not_allowed") {
    await recordPublicInboundLog(env, {
      id: requestId,
      method: request.method,
      routeId: resolved.routeId,
      remainingPath: resolved.remainingPath,
      search: url.search,
      kind,
      result: "rejected",
      status: 405,
      error: "oauth_method_not_allowed",
      subscriberCount: resolved.subscribers.length,
      bodyBytes: inboundBodyBytes(request, body)
    });
    return Response.json(
      { error: "oauth_method_not_allowed" },
      { status: 405, headers: { Allow: "GET, POST" } }
    );
  }

  if (delivery === "oauth") {
    const result = await stub.proxyOAuth(payload);
    await recordPublicInboundLog(env, {
      id: requestId,
      method: request.method,
      routeId: resolved.routeId,
      remainingPath: resolved.remainingPath,
      search: url.search,
      kind,
      result: result.kind === "proxy" ? "proxied" : "rejected",
      status: result.status,
      error: result.kind === "error" ? result.error : null,
      subscriberCount: resolved.subscribers.length,
      deliveredSubscriberCount: result.kind === "proxy" ? 1 : 0,
      bodyBytes: inboundBodyBytes(request, body)
    });
    return proxyResultToResponse(result);
  }

  const deliveredSubscriberCount = await stub.countWebhookFanoutDeliveries(
    resolved.remainingPath
  );
  await recordPublicInboundLog(env, {
    id: requestId,
    method: request.method,
    routeId: resolved.routeId,
    remainingPath: resolved.remainingPath,
    search: url.search,
    kind,
    result: "accepted",
    status: 202,
    subscriberCount: resolved.subscribers.length,
    deliveredSubscriberCount,
    bodyBytes: inboundBodyBytes(request, body)
  });
  ctx.waitUntil(stub.fanOut(payload));
  return Response.json({ accepted: true }, { status: 202 });
}

function newPublicRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function inboundLogKind(delivery: DeliveryClass): InboundLogKind {
  return delivery === "fanout" ? "webhook" : "oauth";
}

/** Persist metadata for one public ingress request; never the body, query, or headers. */
async function recordPublicInboundLog(
  env: Env,
  event: InboundLogEventInput
): Promise<void> {
  await routerIndexStub(env).recordInboundEvents([event]);
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

/** Same `404` `route_not_found` as an unmatched route, with no Durable Object or log write. */
function scannerProbeNotFound(): Response {
  return Response.json({ error: "route_not_found" }, { status: 404 });
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
  const indexed = await routerIndexStub(env).indexedPublicRoutePresence(
    candidate && isValidRouteId(candidate) ? candidate : undefined
  );

  if (indexed.named && candidate) {
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

  if (indexed.root) {
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
  }

  return null;
}
