/** Milliseconds between sidecar heartbeat POSTs that keep a subscriber alive. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/** Milliseconds a subscriber stays registered without a heartbeat. */
export const SUBSCRIBER_TTL_MS = 300_000;

/** Milliseconds to wait for a subscriber to answer a forwarded request. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Milliseconds to wait when deregistering a subscriber on disconnect. */
export const DEREGISTER_TIMEOUT_MS = 5_000;
