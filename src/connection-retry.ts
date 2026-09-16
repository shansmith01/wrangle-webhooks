/** Ceiling for exponential backoff between sidecar reconnect attempts. */
export const CONNECTION_RETRY_MAX_DELAY_MS = 30_000;

/** Sidecar registration/heartbeat failure that should be retried. */
export class RetryableConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableConnectionError";
  }
}

/** Thrown when a public-target sidecar is aborted before it is ready. */
export function publicConnectionAbortedError(): Error {
  return new Error("PublicConnection aborted");
}

/** Thrown when a reverse-tunnel sidecar is aborted before it is ready. */
export function tunnelConnectionAbortedError(): Error {
  return new Error("TunnelConnection aborted");
}

/** Retry `fn` with exponential backoff until `signal` is aborted. */
export async function retryUntilAborted<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  abortedError: () => Error
): Promise<T> {
  let delay = 1_000;
  for (;;) {
    if (signal.aborted) {
      throw abortedError();
    }
    try {
      return await fn();
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      await sleepUntilAborted(delay, signal, abortedError);
      delay = Math.min(delay * 2, CONNECTION_RETRY_MAX_DELAY_MS);
    }
  }
}

/** Sleep `ms` milliseconds, rejecting with `abortedError` if `signal` fires. */
export function sleepUntilAborted(
  ms: number,
  signal: AbortSignal,
  abortedError: () => Error
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
