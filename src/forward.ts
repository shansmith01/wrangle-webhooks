import {
  DELIVERY_TIMEOUT_MS,
  ROUTER_HEADER_REQUEST_ID,
  ROUTER_HEADER_ROUTE,
  ROUTER_HEADER_SUBSCRIBER,
  ROUTER_HEADER_TOKEN,
  joinTargetUrl,
  shouldForwardHeader
} from "./shared";
import {
  TUNNEL_MAX_BODY_BYTES,
  encodeBody,
  serializeHeaders,
  type HeaderPair
} from "./tunnel-protocol";
import type { ProxyResult, Subscriber } from "./types";

export function buildForwardHeaders(options: {
  incoming: Headers;
  routeId: string;
  subscriberId: string;
  requestId: string;
  publicHost: string;
  publicProto: string;
  clientIp: string | null;
  forwardToken: string;
}): Headers {
  const headers = new Headers();
  options.incoming.forEach((value, name) => {
    if (shouldForwardHeader(name)) {
      headers.append(name, value);
    }
  });

  headers.set(ROUTER_HEADER_ROUTE, options.routeId);
  headers.set(ROUTER_HEADER_SUBSCRIBER, options.subscriberId);
  headers.set(ROUTER_HEADER_REQUEST_ID, options.requestId);
  if (options.forwardToken) {
    headers.set(ROUTER_HEADER_TOKEN, options.forwardToken);
  }
  headers.set("X-Forwarded-Host", options.publicHost);
  headers.set("X-Forwarded-Proto", options.publicProto);

  if (options.clientIp) {
    const existing = options.incoming.get("X-Forwarded-For");
    headers.set(
      "X-Forwarded-For",
      existing ? `${existing}, ${options.clientIp}` : options.clientIp
    );
  }

  return headers;
}

export async function deliverToSubscriber(options: {
  subscriber: Subscriber;
  remainingPath: string;
  search: string;
  method: string;
  body: ArrayBuffer;
  headers: Headers;
}): Promise<Response> {
  const url = joinTargetUrl(
    options.subscriber.targetBaseUrl,
    options.remainingPath,
    options.search
  );
  const init: RequestInit = {
    method: options.method,
    headers: options.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
  };
  if (options.method !== "GET" && options.method !== "HEAD") {
    init.body = options.body;
  }
  return fetch(url, init);
}

export async function captureSubscriberResponse(response: Response): Promise<ProxyResult> {
  const body = await response.arrayBuffer();
  if (body.byteLength > TUNNEL_MAX_BODY_BYTES) {
    return {
      kind: "error",
      status: 502,
      error: "subscriber_response_too_large"
    };
  }
  return {
    kind: "proxy",
    status: response.status,
    headers: filterResponseHeaders(serializeHeaders(response.headers)),
    bodyBase64: encodeBody(body)
  };
}

export function filterResponseHeaders(pairs: HeaderPair[]): HeaderPair[] {
  return pairs.filter(([name]) => shouldForwardHeader(name));
}
