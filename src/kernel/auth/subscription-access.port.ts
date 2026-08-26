import type { SessionUser, SubscriptionState } from './session-user.interface';

/** Minimal billing capability needed by the cross-cutting subscription guard. */
export interface SubscriptionAccessPort {
  getForUser(user: SessionUser): Promise<SubscriptionState>;
}

export const SUBSCRIPTION_ACCESS = Symbol('SubscriptionAccess');
