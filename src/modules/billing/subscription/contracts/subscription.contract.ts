export type SubscriptionPlanContract = 'free' | 'pro';
export type SubscriptionStatusContract = 'active' | 'cancelled' | 'expired';

export interface SubscriptionContract {
  userId: string;
  plan: SubscriptionPlanContract;
  status: SubscriptionStatusContract;
  currentPeriodEnd: string | null;
}
