import {
  BUILD_PROFILES,
  BUILD_PROFILE_CAPABILITY_CEILINGS,
  PACK_ARTIFACT_INVENTORY,
  artifactExclusionsFor,
  assertManifestWithinBuildProfile,
  buildProfileAllowsEdition,
  parseBuildProfile,
} from './build-profile.js';
import { PACK_MANIFESTS } from './manifests.js';
import { resolveCapabilities } from './capability-resolver.js';

const EXPECTED_RESOLVED_KEYS = [
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

const AUTH_FLAGS_BY_EDITION = {
  saas: { selfServeAuthEnabled: true, eduAuthEnabled: false },
  edu: { selfServeAuthEnabled: false, eduAuthEnabled: true },
  enterprise: { selfServeAuthEnabled: false, eduAuthEnabled: false },
} as const;

const EXPECTED_RESOLVED_KEYS_BY_EDITION = {
  saas: [
    ...EXPECTED_RESOLVED_KEYS.slice(0, 2),
    'identity.self-serve-auth',
    ...EXPECTED_RESOLVED_KEYS.slice(2),
  ],
  edu: [
    ...EXPECTED_RESOLVED_KEYS.slice(0, 2),
    'identity.edu-auth',
    ...EXPECTED_RESOLVED_KEYS.slice(2),
  ],
  enterprise: EXPECTED_RESOLVED_KEYS,
} as const;

function allEnabledConfig(
  profile: 'hosted-saas' | 'hosted-edu' | 'enterprise',
  edition: 'saas' | 'edu' | 'enterprise',
) {
  return {
    auth: AUTH_FLAGS_BY_EDITION[edition],
    composition: { profile, edition },
    subscription: { gateEnabled: true },
    envProvisioning: { enabled: true },
    gcpDeployments: { enabled: true },
    deploymentHistory: { enabled: true },
    previewDeployments: { enabled: true },
    driftDetection: { enabled: true },
    driftRepair: { enabled: true },
    projectSyncSnapshots: { enabled: true },
    workflowSettingsPreview: { enabled: true },
    workflowUpdatePr: { enabled: true },
    projectTargetManagement: { enabled: true },
    ciRunTracking: { enabled: true },
    usageQuotas: { enabled: true },
    workspaces: { enabled: true },
    hierarchy: { enabled: true },
    auditEvents: { enabled: true },
    notifications: { enabled: true },
  } as never;
}

describe('build profiles', () => {
  it('declares exactly the approved profile-to-edition ceiling', () => {
    expect(BUILD_PROFILES).toEqual({
      'hosted-saas': {
        editions: ['saas'],
        excludedEditions: ['edu', 'enterprise'],
      },
      'hosted-edu': {
        editions: ['edu'],
        excludedEditions: ['saas', 'enterprise'],
      },
      enterprise: {
        editions: ['enterprise'],
        excludedEditions: ['saas', 'edu'],
      },
    });
  });

  it.each([
    [undefined, 'enterprise'],
    ['', 'enterprise'],
    [' HOSTED-SaaS ', 'hosted-saas'],
    ['hosted-edu', 'hosted-edu'],
    ['enterprise', 'enterprise'],
  ] as const)('parses %p as %s', (raw, expected) => {
    expect(parseBuildProfile(raw)).toBe(expected);
  });

  it('rejects an unknown profile instead of falling back', () => {
    expect(() => parseBuildProfile('saas')).toThrow(/Allowed values/);
  });

  it('uses set membership for edition ceilings', () => {
    expect(buildProfileAllowsEdition('hosted-saas', 'saas')).toBe(true);
    expect(buildProfileAllowsEdition('hosted-saas', 'edu')).toBe(false);
    expect(buildProfileAllowsEdition('hosted-edu', 'edu')).toBe(true);
    expect(buildProfileAllowsEdition('hosted-edu', 'saas')).toBe(false);
    expect(buildProfileAllowsEdition('enterprise', 'enterprise')).toBe(true);
    expect(buildProfileAllowsEdition('enterprise', 'saas')).toBe(false);
  });

  it('exposes capability ceilings and derives exclusions from profile data', () => {
    expect(
      BUILD_PROFILE_CAPABILITY_CEILINGS['hosted-edu'].has('identity.lms-lti'),
    ).toBe(true);
    expect(
      BUILD_PROFILE_CAPABILITY_CEILINGS.enterprise.has(
        'runtime.air-gap-packaging',
      ),
    ).toBe(true);
    expect(artifactExclusionsFor('enterprise')).toEqual({
      sourceRoots: [
        'src/packs/saas',
        'src/packs/edu',
        'src/modules/identity-access/auth/edu',
      ],
      symbols: ['SaasOnlyCapabilityMarker', 'EduOnlyCapabilityMarker'],
    });
    expect(PACK_ARTIFACT_INVENTORY).toEqual({
      saas: {
        sourceRoots: ['src/packs/saas'],
        symbols: ['SaasOnlyCapabilityMarker'],
      },
      edu: {
        sourceRoots: ['src/packs/edu', 'src/modules/identity-access/auth/edu'],
        symbols: ['EduOnlyCapabilityMarker'],
      },
      enterprise: {
        sourceRoots: ['src/packs/enterprise'],
        symbols: ['EnterpriseClientPolicyPack'],
      },
    });
  });

  it.each([
    ['hosted-saas', 'saas'],
    ['hosted-edu', 'edu'],
    ['enterprise', 'enterprise'],
  ] as const)('accepts the %s/%s manifest', (profile, edition) => {
    expect(() =>
      assertManifestWithinBuildProfile(profile, PACK_MANIFESTS[edition]),
    ).not.toThrow();
  });

  it('rejects a manifest supplied by a later runtime layer outside the ceiling', () => {
    expect(() =>
      assertManifestWithinBuildProfile('enterprise', PACK_MANIFESTS.saas),
    ).toThrow(/not allowed by build profile 'enterprise'/);
  });

  it.each([
    ['hosted-saas', 'saas'],
    ['hosted-edu', 'edu'],
    ['enterprise', 'enterprise'],
  ] as const)('resolves the expected key set for %s/%s', (profile, edition) => {
    const resolved = resolveCapabilities({
      manifest: PACK_MANIFESTS[edition],
      config: allEnabledConfig(profile, edition),
    });

    expect([...resolved]).toEqual(EXPECTED_RESOLVED_KEYS_BY_EDITION[edition]);
  });
});
