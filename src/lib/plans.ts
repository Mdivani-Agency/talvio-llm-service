/*
 * AI plans the service knows. The plan comes from the `plan` claim that talvio-web-app's
 * custom access-token hook adds (MDI-440). A token with any other plan is refused, so a new
 * plan must be added here, with its limits (MDI-214), before the web starts issuing it.
 */
export const PLANS = ['free'] as const;

export type Plan = (typeof PLANS)[number];

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}
