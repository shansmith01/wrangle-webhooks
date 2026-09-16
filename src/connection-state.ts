/** Why a sidecar is connecting, live, unauthorized, network-failed, or disconnected. */
export type ConnectionStateReason =
  | "connecting"
  | "connected"
  | "unauthorized"
  | "network_error"
  | "disconnected";

/** Map an HTTP error or thrown error to unauthorized vs network_error. */
export function classifyConnectionFailure(
  error: unknown,
  statusCode?: number
): Extract<ConnectionStateReason, "unauthorized" | "network_error"> {
  if (statusCode === 401 || statusCode === 403) {
    return "unauthorized";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b/.test(message) || /unauthorized/i.test(message)) {
    return "unauthorized";
  }
  return "network_error";
}

/** Advance connection state after a failure, keeping unauthorized sticky. */
export function nextConnectionFailure(
  current: ConnectionStateReason,
  error: unknown,
  statusCode?: number
): ConnectionStateReason {
  if (current === "disconnected") {
    return current;
  }
  const next = classifyConnectionFailure(error, statusCode);
  if (current === "unauthorized" && next === "network_error") {
    return current;
  }
  return next;
}

