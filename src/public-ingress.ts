import { RouteDurableObject } from "./durable-object";
import {
  inboundBodyBytes,
  type InboundLogEventInput,
  type InboundLogKind
} from "./inbound-log";
import { remainingPathFromPublicUrl } from "./ingress-urls";
import { classifyDelivery, parseFormBody, readOAuthState } from "./oauth-state";
import { durableObjectNameForRoute, isValidRouteId } from "./route-id";
import { routerIndexStub } from "./router-index";
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
          form: null
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

  const body = await request.arrayBuffer();
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
    form
  });
  const kind = inboundLogKind(delivery);

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
      bodyBytes: inboundBodyBytes(request, body)
    });
    return proxyResultToResponse(result);
  }

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
    bodyBytes: inboundBodyBytes(request, body)
  });
  ctx.waitUntil(stub.fanOut(payload));
  return Response.json({ accepted: true }, { status: 202 });
}

function newPublicRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function inboundLogKind(delivery: "oauth" | "fanout"): InboundLogKind {
  return delivery === "oauth" ? "oauth" : "webhook";
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
