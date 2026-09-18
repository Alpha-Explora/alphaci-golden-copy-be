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

function allEnabledConfig(
  profile: 'hosted' | 'enterprise',
  edition: 'saas' | 'edu' | 'enterprise',
) {
  const manifest = PACK_MANIFESTS[edition];
  const capabilities: readonly string[] = manifest.capabilities;
  return {
    auth: {
      selfServeAuthEnabled: capabilities.includes(
        'identity.self-serve-auth',
      ),
    },
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
      hosted: { editions: ['saas', 'edu'], excludedEditions: ['enterprise'] },
      enterprise: {
        editions: ['enterprise'],
        excludedEditions: ['saas', 'edu'],
      },
    });
  });

  it.each([
    [undefined, 'enterprise'],
    ['', 'enterprise'],
    [' HOSTED ', 'hosted'],
    ['enterprise', 'enterprise'],
  ] as const)('parses %p as %s', (raw, expected) => {
    expect(parseBuildProfile(raw)).toBe(expected);
  });

  it('rejects an unknown profile instead of falling back', () => {
    expect(() => parseBuildProfile('saas')).toThrow(/Allowed values/);
  });

  it('uses set membership for edition ceilings', () => {
    expect(buildProfileAllowsEdition('hosted', 'saas')).toBe(true);
    expect(buildProfileAllowsEdition('hosted', 'edu')).toBe(true);
    expect(buildProfileAllowsEdition('hosted', 'enterprise')).toBe(false);
    expect(buildProfileAllowsEdition('enterprise', 'enterprise')).toBe(true);
    expect(buildProfileAllowsEdition('enterprise', 'saas')).toBe(false);
  });

  it('exposes capability ceilings and derives exclusions from profile data', () => {
    expect(
      BUILD_PROFILE_CAPABILITY_CEILINGS.hosted.has('identity.lms-lti'),
    ).toBe(true);
    expect(
      BUILD_PROFILE_CAPABILITY_CEILINGS.enterprise.has(
        'runtime.air-gap-packaging',
      ),
    ).toBe(true);
    expect(artifactExclusionsFor('enterprise')).toEqual({
      sourceRoots: ['src/packs/saas', 'src/packs/edu'],
      symbols: ['SaasOnlyCapabilityMarker', 'EduOnlyCapabilityMarker'],
    });
    expect(PACK_ARTIFACT_INVENTORY).toEqual({
      saas: {
        sourceRoots: ['src/packs/saas'],
        symbols: ['SaasOnlyCapabilityMarker'],
      },
      edu: {
        sourceRoots: ['src/packs/edu'],
        symbols: ['EduOnlyCapabilityMarker'],
      },
      enterprise: {
        sourceRoots: ['src/packs/enterprise'],
        symbols: ['EnterpriseClientPolicyPack'],
      },
    });
  });

  it.each([
    ['hosted', 'saas'],
    ['hosted', 'edu'],
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
    ['hosted', 'saas'],
    ['hosted', 'edu'],
    ['enterprise', 'enterprise'],
  ] as const)('resolves the expected key set for %s/%s', (profile, edition) => {
    const manifest = PACK_MANIFESTS[edition];
    const capabilities: readonly string[] = manifest.capabilities;
    const resolved = resolveCapabilities({
      manifest,
      config: allEnabledConfig(profile, edition),
    });

    const expected = capabilities.includes('identity.self-serve-auth')
      ? [
          ...EXPECTED_RESOLVED_KEYS.slice(0, 2),
          'identity.self-serve-auth',
          ...EXPECTED_RESOLVED_KEYS.slice(2),
        ]
      : EXPECTED_RESOLVED_KEYS;

    expect([...resolved]).toEqual(expected);
  });
});
