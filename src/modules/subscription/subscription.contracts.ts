import type {
  SubscriptionState,
} from '../../common/interfaces/session-user.interface';

export interface SubscriptionBootstrap {
  ensureDefaultFreeSubscription(userId: string): Promise<SubscriptionState>;
}

export const SUBSCRIPTION_BOOTSTRAP = Symbol('SUBSCRIPTION_BOOTSTRAP');
