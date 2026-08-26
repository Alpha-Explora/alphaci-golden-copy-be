export interface UsageSummaryContract {
  projects: number;
  managed_render_services: number;
  managed_vercel_projects: number;
  deployment_targets: number;
  env_keys: number;
  workflow_prs: number;
}
