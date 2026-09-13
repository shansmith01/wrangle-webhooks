import {
  DELIVERY_TIMEOUT_MS,
  ROUTER_HEADER_REQUEST_ID,
  ROUTER_HEADER_ROUTE,
  ROUTER_HEADER_SECRET,
  ROUTER_HEADER_SUBSCRIBER,
  joinTargetUrl,
  shouldForwardHeader
} from "./shared";
import type { Subscriber } from "./types";

export function buildForwardHeaders(options: {
  incoming: Headers;
  routeId: string;
  subscriberId: string;
  requestId: string;
  publicHost: string;
  publicProto: string;
  clientIp: string | null;
  routerSecret: string;
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
  headers.set(ROUTER_HEADER_SECRET, options.routerSecret);
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
}): Promise<void> {
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
  await fetch(url, init);
}

export async function fanOutToSubscribers(options: {
  subscribers: Subscriber[];
  remainingPath: string;
  search: string;
  method: string;
  body: ArrayBuffer;
  incomingHeaders: Headers;
  routeId: string;
  requestId: string;
  publicHost: string;
  publicProto: string;
  clientIp: string | null;
  routerSecret: string;
}): Promise<void> {
  await Promise.allSettled(
    options.subscribers.map(async (subscriber) => {
      const headers = buildForwardHeaders({
        incoming: options.incomingHeaders,
        routeId: options.routeId,
        subscriberId: subscriber.id,
        requestId: options.requestId,
        publicHost: options.publicHost,
        publicProto: options.publicProto,
        clientIp: options.clientIp,
        routerSecret: options.routerSecret
      });
      await deliverToSubscriber({
        subscriber,
        remainingPath: options.remainingPath,
        search: options.search,
        method: options.method,
        body: options.body,
        headers
      });
    })
  );
}
