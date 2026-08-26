export interface DeploymentProvisioningContract {
  projectId: string;
  targets: Array<{
    id: string;
    slot: 'backend' | 'frontend' | 'standalone';
    provider: string;
    status: string;
  }>;
  status: 'completed' | 'partial' | 'failed' | 'skipped';
}
