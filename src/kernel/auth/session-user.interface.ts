export type SubscriptionPlan = 'free' | 'pro';

export type SubscriptionStatus = 'inactive' | 'active' | 'canceled';

export interface SessionUser {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
  onboardingCompleted: boolean;
  /**
   * True when the user is a member of the internal company GitHub org.
   * Internal users bypass the subscription/payment gate entirely.
   */
  isInternal: boolean;
}

export interface SubscriptionState {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  provider: 'mock' | 'supabase' | 'manual' | 'paymongo';
  updatedAt: string;
  planCode?: string;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  amountPhp?: number;
  interval?: 'month' | 'year';
}
