import Stripe from "stripe";

import { STRIPE_SECRET_KEY } from "./env";

/**
 * Lazily-constructed server-side Stripe client. NEVER import from a client
 * component — the secret key is Node-runtime only. apiVersion is intentionally
 * omitted so the account's pinned version (and the SDK's default) is used.
 */
let cached: Stripe | null = null;

export function getStripe(): Stripe {
  if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!cached) cached = new Stripe(STRIPE_SECRET_KEY);
  return cached;
}
