import type { RenderServiceType } from './deployment-target.types';

export interface ProviderCapabilities {
  envVars: boolean;
  logs: boolean;
  deployHistory: boolean;
  teardown: boolean;
  managedMode: boolean;
  liveStatus: boolean;
  connectivity: 'direct' | 'indirect';
  enumerable: boolean;
  credentialCustody: 'platform' | 'external';
  /** Whether this provider is available through the runtime env API. */
  envProvisioning?: boolean;
  /** Whether this provider exposes a branch-scoped preview lane. */
  previewDeployments?: boolean;
}

export interface ProviderFormField {
  key: string;
  label: string;
  required: boolean;
}

export interface ProviderFormSchema {
  fields: ProviderFormField[];
}

/** Provider-owned links used by the application without vendor branches. */
export interface DeploymentProviderPresentationTarget {
  providerProjectId: string;
  providerProjectName: string;
  providerMetadata: Record<string, unknown>;
  branchName?: string | null;
}

export interface DeploymentProviderPresentation {
  publicUrl(
    target: DeploymentProviderPresentationTarget,
    lane?: 'production' | 'preview',
  ): string | null;
  dashboardUrl(target: DeploymentProviderPresentationTarget): string | null;
  consoleUrl(target: DeploymentProviderPresentationTarget): string | null;
}

export interface DeploymentProviderConnectionPreparationInput {
  token: string;
  config: Record<string, unknown>;
  account: { id: string; metadata?: Record<string, unknown> };
  client: {
    validateTeamAccess?: (
      token: string,
      teamId: string,
    ) => Promise<{ id: string; slug?: string; name?: string }>;
  };
}

/**
 * Application-facing seam for provider-owned target defaults/policy. The
 * application may keep the historical Render-shaped storage columns for
 * compatibility, but it must not import the provider implementation to get
 * those defaults.
 */
export interface DeploymentTargetDefaultsPort {
  resolveDefaults(input: {
    ownershipMode: 'byo' | 'flowci_managed';
    serviceType?:
      | 'web_service'
      | 'private_service'
      | 'background_worker'
      | 'cron_job'
      | null
      | undefined;
    instanceType?: string | null | undefined;
    region?: string | null | undefined;
  }): {
    serviceType: RenderServiceType;
    instanceType: string;
    region: string;
  };
}

/** Runtime composition token for provider-owned target defaults. */
export const DEPLOYMENT_TARGET_DEFAULTS = Symbol('DeploymentTargetDefaults');

/**
 * Provider ids are open data, not a closed TypeScript union. A provider plugin
 * owns its id and registers it at runtime; adding one must not require editing
 * this contract or a central DTO union.
 */
export type DeploymentProviderId = string;

export interface DeploymentProvider {
  readonly id: string;
  readonly label: string;
  readonly supportedSlots: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly configSchema: ProviderFormSchema;
  readonly credentialSchema: ProviderFormSchema;
  /** Optional until a provider exposes stable human-facing console links. */
  readonly presentation?: DeploymentProviderPresentation;
  /** Optional provider-owned wording for an unsupported deployment slot. */
  readonly slotViolationMessage?: (slot: string) => string;
  /** Provider-owned connection metadata and optional team validation. */
  prepareConnection?(
    input: DeploymentProviderConnectionPreparationInput,
  ): Promise<Record<string, unknown>>;
  isEnabled(): { enabled: boolean; reason?: string };
  validateConfig(config: Record<string, unknown>): void;
}
