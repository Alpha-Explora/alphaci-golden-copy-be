import { CAPABILITIES } from './capability-registry.js';
import type {
  CapabilityManifest,
  CapabilityRecord,
  ResolveCapabilitiesInput,
} from './capability-types.js';
import { resolveCapabilities } from './capability-resolver.js';
import { PACK_MANIFESTS } from './manifests.js';
import type { AppConfig } from '#kernel/config/app.config.js';

const REGISTRY_KEYS = [
  'identity.workspaces',
  'identity.hierarchy',
  'identity.sso-scim',
  'identity.lms-lti',
  'identity.cohort-policy',
  'identity.edu-provisioning',
  'identity.ferpa-workflows',
  'identity.edition-entitlements',
  'identity.self-serve-auth',
  'identity.edu-auth',
  'platform.audit-events',
  'platform.notifications',
  'platform.data-residency',
  'platform.public-site',
  'billing.subscription-gate',
  'billing.usage-quotas',
  'billing.checkout',
  'runtime.env-provisioning',
  'runtime.gcp-deployments',
  'runtime.deployment-history',
  'runtime.preview-deployments',
  'runtime.drift-detection',
  'runtime.drift-repair',
  'runtime.managed-secrets',
  'runtime.air-gap-packaging',
  'runtime.customer-isolation',
  'runtime.client-composition',
  'projects.sync-snapshots',
  'projects.workflow-settings-preview',
  'projects.workflow-update-pr',
  'projects.target-management',
  'pipelines.ci-run-tracking',
  'pipelines.github-enterprise-server',
] as const;

const SAAS_KEYS = [
  'identity.workspaces',
  'identity.hierarchy',
  'identity.edition-entitlements',
  'identity.self-serve-auth',
  'platform.audit-events',
  'platform.notifications',
  'platform.public-site',
  'billing.subscription-gate',
  'billing.usage-quotas',
  'billing.checkout',
  'runtime.env-provisioning',
  'runtime.gcp-deployments',
  'runtime.deployment-history',
  'runtime.preview-deployments',
  'runtime.drift-detection',
  'runtime.drift-repair',
  'projects.sync-snapshots',
  'projects.workflow-settings-preview',
  'projects.workflow-update-pr',
  'projects.target-management',
  'pipelines.ci-run-tracking',
] as const;

const EDU_KEYS = [
  'identity.workspaces',
  'identity.hierarchy',
  'identity.lms-lti',
  'identity.cohort-policy',
  'identity.edu-provisioning',
  'identity.ferpa-workflows',
  'identity.edition-entitlements',
  'identity.edu-auth',
  'platform.audit-events',
  'platform.notifications',
  'billing.subscription-gate',
  'billing.usage-quotas',
  'runtime.env-provisioning',
  'runtime.gcp-deployments',
  'runtime.deployment-history',
  'runtime.preview-deployments',
  'runtime.drift-detection',
  'runtime.drift-repair',
  'projects.sync-snapshots',
  'projects.workflow-settings-preview',
  'projects.workflow-update-pr',
  'projects.target-management',
  'pipelines.ci-run-tracking',
] as const;

const ENTERPRISE_KEYS = [
  'identity.workspaces',
  'identity.hierarchy',
  'identity.sso-scim',
  'identity.edition-entitlements',
  'platform.audit-events',
  'platform.notifications',
  'platform.data-residency',
  'billing.subscription-gate',
  'billing.usage-quotas',
  'runtime.env-provisioning',
  'runtime.gcp-deployments',
  'runtime.deployment-history',
  'runtime.preview-deployments',
  'runtime.drift-detection',
  'runtime.drift-repair',
  'runtime.managed-secrets',
  'runtime.air-gap-packaging',
  'runtime.customer-isolation',
  'runtime.client-composition',
  'projects.sync-snapshots',
  'projects.workflow-settings-preview',
  'projects.workflow-update-pr',
  'projects.target-management',
  'pipelines.ci-run-tracking',
  'pipelines.github-enterprise-server',
] as const;

const EXECUTABLE_KEYS = [
  'identity.workspaces',
  'identity.hierarchy',
  'platform.audit-events',
  'platform.notifications',
  'billing.subscription-gate',
  'billing.usage-quotas',
  'runtime.env-provisioning',
  'runtime.gcp-deployments',
  'runtime.deployment-history',
  'runtime.preview-deployments',
  'runtime.drift-detection',
  'runtime.drift-repair',
  'projects.sync-snapshots',
  'projects.workflow-settings-preview',
  'projects.workflow-update-pr',
  'projects.target-management',
  'pipelines.ci-run-tracking',
] as const;

const SAAS_EXECUTABLE_KEYS = [
  ...EXECUTABLE_KEYS.slice(0, 2),
  'identity.self-serve-auth',
  ...EXECUTABLE_KEYS.slice(2),
] as const;

const EDU_EXECUTABLE_KEYS = [
  ...EXECUTABLE_KEYS.slice(0, 2),
  'identity.edu-auth',
  ...EXECUTABLE_KEYS.slice(2),
] as const;

const ENTERPRISE_EXECUTABLE_KEYS = [
  ...EXECUTABLE_KEYS.slice(0, 12),
  'runtime.client-composition',
  ...EXECUTABLE_KEYS.slice(12),
] as const;

const EXECUTABLE_KEYS_BY_EDITION = {
  saas: SAAS_EXECUTABLE_KEYS,
  edu: EDU_EXECUTABLE_KEYS,
  enterprise: EXECUTABLE_KEYS,
} as const;

const allFlagsEnabled = {
  auth: { selfServeAuthEnabled: true, eduAuthEnabled: true },
  envProvisioning: { enabled: true },
  gcpDeployments: { enabled: true, dedicatedProjectsEnabled: true },
  projectSyncSnapshots: {
    enabled: true,
    liveGithubEnabled: true,
    liveProvidersEnabled: true,
  },
  workflowSettingsPreview: { enabled: true },
  workflowUpdatePr: { enabled: true },
  projectTargetManagement: { enabled: true },
  ciRunTracking: { enabled: true, liveGithubEnabled: true },
  deploymentHistory: { enabled: true, liveProvidersEnabled: true },
  previewDeployments: { enabled: true },
  driftDetection: { enabled: true },
  driftRepair: { enabled: true, liveRepairEnabled: true },
  driftLiveChecks: { enabled: true },
  usageQuotas: { enabled: true },
  workspaces: { enabled: true },
  auditEvents: { enabled: true },
  notifications: { enabled: true },
  hierarchy: { enabled: true },
  subscription: { gateEnabled: true },
  composition: {
    edition: 'enterprise',
    profile: 'enterprise',
    client: { id: null, configPath: null, enabled: true },
  },
} as unknown as AppConfig;

const configForManifest = (
  edition: CapabilityManifest['edition'],
  source: AppConfig = allFlagsEnabled,
): AppConfig => {
  const config = structuredClone(source);
  const profileByEdition: Record<
    CapabilityManifest['edition'],
    AppConfig['composition']['profile']
  > = {
    saas: 'hosted-saas',
    edu: 'hosted-edu',
    enterprise: 'enterprise',
  };
  const capabilities: readonly string[] = PACK_MANIFESTS[edition].capabilities;
  config.composition = {
    edition,
    profile: profileByEdition[edition],
    client: {
      id: null,
      configPath: null,
      enabled: capabilities.includes('runtime.client-composition'),
    },
  };
  return config;
};

const manifest = (capabilities: readonly string[]): CapabilityManifest =>
  ({ edition: 'saas', capabilities }) as CapabilityManifest;

const record = (
  key: string,
  requires: readonly string[] = [],
): CapabilityRecord => ({
  key,
  context: 'test',
  description: 'test capability',
  maturity: 'stable',
  configuration: 'none',
  configurationFlags: [],
  requires,
});

describe('declared composition catalog', () => {
  it('keeps the 33 registry records in their existing order', () => {
    expect(CAPABILITIES).toHaveLength(33);
    expect(CAPABILITIES.map(({ key }) => key)).toEqual(REGISTRY_KEYS);
  });

  it.each([
    ['saas', SAAS_KEYS],
    ['edu', EDU_KEYS],
    ['enterprise', ENTERPRISE_KEYS],
  ] as const)(
    'declares the current %s manifest projection',
    (edition, keys) => {
      expect(PACK_MANIFESTS[edition]).toEqual({ edition, capabilities: keys });
    },
  );

  it('keeps EDU explicit while proving its EDU-only keys are not implemented', () => {
    expect(PACK_MANIFESTS.edu.capabilities).toContain('identity.lms-lti');
    expect(
      CAPABILITIES.find(({ key }) => key === 'identity.lms-lti')?.maturity,
    ).toBe('not-implemented');
  });
});

describe('resolveCapabilities', () => {
  it('resolves the same executable surface for every current manifest when all flags are true', () => {
    for (const currentManifest of Object.values(PACK_MANIFESTS)) {
      const capabilities: readonly string[] = currentManifest.capabilities;
      const expected = capabilities.includes('runtime.client-composition')
        ? ENTERPRISE_EXECUTABLE_KEYS
        : EXECUTABLE_KEYS_BY_EDITION[currentManifest.edition];
      expect([
        ...resolveCapabilities({
          manifest: currentManifest,
          config: configForManifest(currentManifest.edition),
        }),
      ]).toEqual(expected);
    }
  });

  it('requires every configuration flag to be true', () => {
    const config = structuredClone(allFlagsEnabled);
    config.gcpDeployments.enabled = false;

    expect(
      resolveCapabilities({
        manifest: PACK_MANIFESTS.enterprise,
        config: configForManifest('enterprise', config),
      }).has('runtime.gcp-deployments'),
    ).toBe(false);
  });

  it('keeps base capabilities active when optional live modes are disabled', () => {
    const config = structuredClone(allFlagsEnabled);
    config.gcpDeployments.dedicatedProjectsEnabled = false;
    config.projectSyncSnapshots.liveGithubEnabled = false;
    config.projectSyncSnapshots.liveProvidersEnabled = false;
    config.deploymentHistory.liveProvidersEnabled = false;
    config.driftLiveChecks.enabled = false;
    config.driftRepair.liveRepairEnabled = false;
    config.ciRunTracking.liveGithubEnabled = false;

    const keys = resolveCapabilities({
      manifest: PACK_MANIFESTS.enterprise,
      config: configForManifest('enterprise', config),
    });

    expect(keys.has('runtime.gcp-deployments')).toBe(true);
    expect(keys.has('projects.sync-snapshots')).toBe(true);
    expect(keys.has('runtime.deployment-history')).toBe(true);
    expect(keys.has('runtime.drift-detection')).toBe(true);
    expect(keys.has('runtime.drift-repair')).toBe(true);
    expect(keys.has('pipelines.ci-run-tracking')).toBe(true);
  });

  it('removes a dependent when a required capability is absent', () => {
    const config = structuredClone(allFlagsEnabled);
    config.deploymentHistory.enabled = false;
    const keys = resolveCapabilities({
      manifest: PACK_MANIFESTS.saas,
      config: configForManifest('saas', config),
    });

    expect(keys.has('runtime.deployment-history')).toBe(false);
    expect(keys.has('runtime.preview-deployments')).toBe(false);
  });

  it('removes a capability whose direct dependency is omitted from the manifest', () => {
    const keys = resolveCapabilities({
      manifest: manifest(['runtime.preview-deployments']),
      config: configForManifest('saas'),
    });

    expect(keys.has('runtime.preview-deployments')).toBe(false);
  });

  it('removes capabilities with a missing transitive dependency', () => {
    const registry = [
      record('identity.workspaces'),
      record('identity.hierarchy', ['identity.workspaces']),
      record('platform.audit-events', ['identity.hierarchy']),
    ];

    const keys = resolveCapabilities({
      registry,
      manifest: manifest([
        'identity.workspaces',
        'identity.hierarchy',
        'platform.audit-events',
      ]),
      config: configForManifest('saas'),
    });

    expect([...keys]).toEqual([
      'identity.workspaces',
      'identity.hierarchy',
      'platform.audit-events',
    ]);

    const narrowed = resolveCapabilities({
      registry,
      manifest: manifest(['identity.hierarchy', 'platform.audit-events']),
      config: configForManifest('saas'),
    });
    expect([...narrowed]).toEqual([]);
  });

  it('never returns not-implemented manifest entries', () => {
    const keys = resolveCapabilities({
      manifest: PACK_MANIFESTS.edu,
      config: configForManifest('edu'),
    });

    expect(keys.has('identity.lms-lti')).toBe(false);
    expect(keys.has('identity.edition-entitlements')).toBe(false);
  });

  it('rejects an unknown manifest capability', () => {
    expect(() =>
      resolveCapabilities({
        manifest: manifest([
          ...PACK_MANIFESTS.saas.capabilities,
          'unknown.capability',
        ]),
        config: configForManifest('saas'),
      }),
    ).toThrow('unknown manifest capability');
  });

  it('rejects an unknown required capability', () => {
    const registry = [record('identity.workspaces', ['unknown.capability'])];

    expect(() =>
      resolveCapabilities({
        registry,
        manifest: manifest(['identity.workspaces']),
        config: configForManifest('saas'),
      }),
    ).toThrow('unknown required capability');
  });

  it('rejects a manifest that is not in registry order', () => {
    expect(() =>
      resolveCapabilities({
        manifest: manifest(['identity.hierarchy', 'identity.workspaces']),
        config: configForManifest('saas'),
      }),
    ).toThrow('manifest is not in registry order');
  });

  it('rejects a cyclic requires graph', () => {
    const registry = [
      record('identity.workspaces', ['identity.hierarchy']),
      record('identity.hierarchy', ['identity.workspaces']),
    ];

    expect(() =>
      resolveCapabilities({
        registry,
        manifest: manifest(['identity.workspaces', 'identity.hierarchy']),
        config: configForManifest('saas'),
      }),
    ).toThrow('requires cycle');
  });

  it('is deterministic and does not mutate its inputs', () => {
    const input: ResolveCapabilitiesInput = {
      manifest: PACK_MANIFESTS.saas,
      config: configForManifest('saas'),
    };
    const before = structuredClone(input);

    const first = resolveCapabilities(input);
    const second = resolveCapabilities(input);

    expect([...first]).toEqual([...second]);
    expect(first).not.toBe(second);
    expect(input).toEqual(before);
  });
});
