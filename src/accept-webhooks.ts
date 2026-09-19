/**
 * True when DEV_ROUTER_NO_WEBHOOKS is `1`, `true`, or `yes` (case-insensitive).
 * Any other value, including unset, means this subscriber accepts webhook fan-out.
 */
export function envDisablesWebhookFanout(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Parse register JSON or tunnel query `acceptWebhooks`.
 * Missing, `true`, or `1` means accept webhooks; `false` or `0` means `--no-webhooks`.
 */
export function parseAcceptWebhooksValue(value: unknown): boolean {
  if (value === false || value === 0 || value === "0" || value === "false") {
    return false;
  }
  return true;
}

/**
 * Resolve whether this sidecar should accept webhook fan-out.
 * `--no-webhooks` or DEV_ROUTER_NO_WEBHOOKS wins; default is accept.
 */
export function resolveAcceptWebhooks(options: {
  flag?: boolean;
  envValue?: string;
  acceptWebhooks?: boolean;
}): boolean {
  if (options.acceptWebhooks === false || options.flag === true) {
    return false;
  }
  if (envDisablesWebhookFanout(options.envValue)) {
    return false;
  }
  return true;
}
