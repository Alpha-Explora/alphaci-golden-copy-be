export interface DeploymentProviderContract {
  id: string;
  label: string;
  supportedSlots: string[];
  capabilities: Record<string, boolean | string>;
}
