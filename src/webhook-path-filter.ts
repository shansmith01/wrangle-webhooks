import {
  normalizeWebhookFilterPath,
  type WebhookFanoutRuleMode
} from "./webhook-filter-path";

/** One operator-registered webhook path prefix rule for a route. */
export interface WebhookFanoutRule {
  routeId: string;
  mode: WebhookFanoutRuleMode;
  remainingPath: string;
  environmentId: string | null;
  createdAt: number;
}

/** Route-level webhook fan-out settings used when selecting subscribers. */
export interface WebhookFanoutSettings {
  routeId: string;
  denyAllWebhooks: boolean;
  rules: WebhookFanoutRule[];
}

/** Subscriber fields consulted when filtering webhook fan-out. */
export interface WebhookFanoutSubscriber {
  id: string;
  environmentId: string | null;
  acceptWebhooks: boolean;
}

/**
 * True when the remaining path equals the prefix or is a child segment (`/webhooks/mews/x`).
 * `/webhooks/mews` does not match `/webhooks/mews-backup`. Query string is ignored.
 */
export function remainingPathMatchesWebhookPrefix(
  remainingPath: string,
  prefix: string
): boolean {
  const path = normalizeWebhookFilterPath(remainingPath);
  const normalizedPrefix = normalizeWebhookFilterPath(prefix);
  if (normalizedPrefix === "/") {
    return false;
  }
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

/**
 * Choose which subscribers should receive this webhook remaining path.
 * Route deny-all or subscriber `--no-webhooks` skips delivery; allow rules are opt-in per applicable scope.
 */
export function selectWebhookFanoutSubscribers<T extends WebhookFanoutSubscriber>(
  subscribers: readonly T[],
  remainingPath: string,
  settings: Pick<WebhookFanoutSettings, "denyAllWebhooks" | "rules">
): T[] {
  if (settings.denyAllWebhooks) {
    return [];
  }
  return subscribers.filter((subscriber) =>
    subscriberAcceptsWebhookPath(subscriber, remainingPath, settings.rules)
  );
}

function subscriberAcceptsWebhookPath(
  subscriber: WebhookFanoutSubscriber,
  remainingPath: string,
  rules: readonly WebhookFanoutRule[]
): boolean {
  if (!subscriber.acceptWebhooks) {
    return false;
  }
  const applicable = rules.filter(
    (rule) =>
      rule.environmentId === null || rule.environmentId === subscriber.environmentId
  );
  const allows = applicable.filter((rule) => rule.mode === "allow");
  const denies = applicable.filter((rule) => rule.mode === "deny");
  if (
    allows.length > 0 &&
    !allows.some((rule) =>
      remainingPathMatchesWebhookPrefix(remainingPath, rule.remainingPath)
    )
  ) {
    return false;
  }
  if (
    denies.some((rule) =>
      remainingPathMatchesWebhookPrefix(remainingPath, rule.remainingPath)
    )
  ) {
    return false;
  }
  return true;
}
