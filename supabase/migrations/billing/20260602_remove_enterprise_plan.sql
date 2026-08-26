-- Migrate existing active enterprise subscribers to pro
UPDATE user_subscriptions
SET
  plan               = 'pro',
  plan_code          = 'pro_monthly',
  amount_php         = 300,
  updated_at         = NOW()
WHERE plan = 'enterprise'
  AND status = 'active';

-- Migrate non-active enterprise records
UPDATE user_subscriptions
SET
  plan       = 'pro',
  plan_code  = 'pro_monthly',
  updated_at = NOW()
WHERE plan = 'enterprise'
  AND status != 'active';

-- Remove enterprise plan from catalog
DELETE FROM subscription_plans WHERE code = 'enterprise_monthly';
