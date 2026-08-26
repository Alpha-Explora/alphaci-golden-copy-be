export type UsageLimitCode =
  | 'projects'
  | 'managed_render_services'
  | 'managed_vercel_projects'
  | 'deployment_targets'
  | 'env_keys'
  | 'workflow_prs';

export interface UsageLimitItem {
  code: UsageLimitCode;
  current: number;
  limit: number;
  upgradeRequired: boolean;
}

export interface UsageMeResponse {
  enabled: boolean;
  plan: 'free' | 'pro';
  items: UsageLimitItem[];
}
