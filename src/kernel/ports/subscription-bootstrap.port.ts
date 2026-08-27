import type { SubscriptionState } from '#kernel/auth/session-user.interface';

/** Minimal billing capability needed while establishing a new account. */
export interface SubscriptionBootstrapPort {
  ensureDefaultFreeSubscription(userId: string): Promise<SubscriptionState>;
}

export const SUBSCRIPTION_BOOTSTRAP = Symbol('SUBSCRIPTION_BOOTSTRAP');
