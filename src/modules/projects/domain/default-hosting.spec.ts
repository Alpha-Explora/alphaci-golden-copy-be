import { WorkflowFragmentRegistry } from '#kernel/ports/workflow-fragment.port';
import { renderWorkflowFragment } from '#modules/runtime/infrastructure/providers/render/render-workflow.fragment';
import { vercelWorkflowFragment } from '#modules/runtime/infrastructure/providers/vercel/vercel-workflow.fragment';
import { DeploymentProvisioningDefaultsService } from '#modules/runtime/application/deployment-provisioning-defaults.service';
import { DeploymentProviderPolicyRegistry } from '#modules/runtime/domain/deployment-provider.policy';
import { RenderDeploymentPolicy } from '#modules/runtime/infrastructure/providers/render/render-deployment.policy';
import type { RenderCostPolicyService } from '#modules/runtime/infrastructure/providers/render/render-cost-policy.service';
import { VercelDeploymentPolicy } from '#modules/runtime/infrastructure/providers/vercel/vercel-deployment.policy';

import { resolveDeploymentWorkflowTargets } from '../application/workflows/deployment-workflow-targets';
import {
  filterDeploymentProvisioningRequest,
  withRepoShapeRootDirectory,
  forceManagedProvisioning,
  resolveSingleRepoDeploymentSlots,
  withDefaultCreateDeploymentProvisioning,
  withDefaultFrontendDeploymentProvisioning,
} from './deployment-provisioning.policy';

/**
 * A project created without touching the wizard's hosting step must still get
 * hosting. Backends did — the Render default was applied automatically — and
 * frontends did not: `vercel` was named the default frontend provider but
 * nothing read that, so a React project's pipeline built, tested, and deployed
 * nowhere. Nothing reported the difference.
 *
 * These tests run the same sequence a provisioner does: apply the product
 * default, force managed hosting, resolve the slots, expand into workflow
 * targets.
 */

const defaults = new DeploymentProvisioningDefaultsService(
  new DeploymentProviderPolicyRegistry([
    // The cost policy is only consulted when normalizing a target, which the
    // default resolution below never reaches.
    new RenderDeploymentPolicy({} as RenderCostPolicyService),
    new VercelDeploymentPolicy(),
  ]),
);

const registry = new WorkflowFragmentRegistry([
  renderWorkflowFragment,
  vercelWorkflowFragment,
]);

function hostingFor(projectTypeId: string) {
  const withDefault = withDefaultCreateDeploymentProvisioning({
    request: undefined,
    projectTypeId,
    serviceName: `${projectTypeId}-svc`,
    repoName: `${projectTypeId}-repo`,
    deploymentProvisioningDefaults: defaults,
  });
  const slots = resolveSingleRepoDeploymentSlots(withDefault);
  const request = filterDeploymentProvisioningRequest(
    forceManagedProvisioning(withDefault),
    slots,
  );

  return {
    providers: (withDefault?.targets ?? []).map(
      (target) => `${target.slot}/${target.provider}`,
    ),
    targets: resolveDeploymentWorkflowTargets(request, slots, '.', registry),
  };
}

describe('default hosting when none was configured', () => {
  it.each([
    ['dotnet', 'backend/render'],
    ['nestjs', 'backend/render'],
    ['nodejs', 'backend/render'],
  ])('gives %s a Render target', (stack, expected) => {
    expect(hostingFor(stack).providers).toEqual([expected]);
  });

  it.each([
    ['react', 'frontend/vercel'],
    ['nextjs', 'frontend/vercel'],
  ])('gives %s a Vercel target', (stack, expected) => {
    expect(hostingFor(stack).providers).toEqual([expected]);
  });

  it('produces deploy jobs for a frontend, not just a target', () => {
    // The target has to survive expandTargets too. Vercel's expansion requires
    // slot 'frontend'; a target the default emitted as 'standalone' would be
    // dropped here and the pipeline would deploy nothing.
    const { targets } = hostingFor('react');

    expect(targets).toHaveLength(1);
    expect(targets[0]?.provider).toBe('vercel');
    expect(targets[0]?.slot).toBe('frontend');
  });

  it('produces deploy jobs for a backend, on the hosted tiers only', () => {
    // Render services are per-branch, so its expansion pins one per hosted
    // tier. dev is absent deliberately: it builds and runs the full quality
    // stage, but a developer runs that branch locally, so a dev service would
    // be one per project that nobody visits.
    const { targets } = hostingFor('dotnet');

    expect(targets.map((target) => target.branchName)).toEqual(['uat', 'main']);
    expect(targets.every((target) => target.provider === 'render')).toBe(true);
  });

  it('leaves a caller-configured target alone', () => {
    const request = {
      enabled: true,
      targets: [
        {
          slot: 'frontend' as const,
          provider: 'vercel',
          ownershipMode: 'flowci_managed' as const,
          projectName: 'chosen-by-the-user',
        },
      ],
    };

    const result = withDefaultCreateDeploymentProvisioning({
      request,
      projectTypeId: 'react',
      serviceName: 'svc',
      repoName: 'repo',
      deploymentProvisioningDefaults: defaults,
    });

    expect(result?.targets).toHaveLength(1);
    expect(result?.targets[0]?.projectName).toBe('chosen-by-the-user');
  });
});

describe('default hosting for a project with two halves', () => {
  // The multi-repo and microservices provisioners resolve the default from the
  // backend's project type, so a two-repository project created without the
  // hosting step got Render for its backend and nothing for its frontend.
  function twoHalves(
    request?: Parameters<
      typeof withDefaultCreateDeploymentProvisioning
    >[0]['request'],
  ) {
    return withDefaultFrontendDeploymentProvisioning({
      request: withDefaultCreateDeploymentProvisioning({
        request,
        projectTypeId: 'nestjs',
        serviceName: 'orders-backend',
        repoName: 'orders-be',
        servicePath: '.',
        deploymentProvisioningDefaults: defaults,
      }),
      serviceName: 'orders-frontend',
      repoName: 'orders-fe',
      servicePath: '.',
      deploymentProvisioningDefaults: defaults,
    });
  }

  it('gives the frontend half a Vercel target beside the backend Render one', () => {
    const result = twoHalves();

    expect(
      result?.targets.map((target) => `${target.slot}/${target.provider}`),
    ).toEqual(['backend/render', 'frontend/vercel']);
    expect(result?.enabled).toBe(true);
    expect(
      result?.targets.find((target) => target.slot === 'frontend')?.projectName,
    ).toBe('orders-frontend');
  });

  it('produces deploy jobs for the frontend repository', () => {
    const request = filterDeploymentProvisioningRequest(
      forceManagedProvisioning(twoHalves()),
      ['frontend'],
    );

    const targets = resolveDeploymentWorkflowTargets(
      request,
      ['frontend'],
      '.',
      registry,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.provider).toBe('vercel');
  });

  it('keeps a frontend target the caller configured, whatever its provider', () => {
    const result = twoHalves({
      enabled: true,
      targets: [
        {
          slot: 'frontend',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          projectName: 'chosen-by-the-user',
        },
      ],
    });

    const frontends = (result?.targets ?? []).filter(
      (target) => target.slot === 'frontend',
    );
    expect(frontends).toHaveLength(1);
    expect(frontends[0]?.projectName).toBe('chosen-by-the-user');
  });

  it('adds nothing when the frontend default is not a frontend target', () => {
    const backendOnlyDefaults = {
      resolveDefaultCreateTarget: () => ({
        slot: 'backend' as const,
        provider: 'render',
        ownershipMode: 'flowci_managed' as const,
      }),
    };

    const result = withDefaultFrontendDeploymentProvisioning({
      request: undefined,
      serviceName: 'orders-frontend',
      repoName: 'orders-fe',
      deploymentProvisioningDefaults: backendOnlyDefaults,
    });

    expect(result).toBeUndefined();
  });

  it('adds no default to either half when the caller turned hosting off', () => {
    const result = twoHalves({ enabled: false, targets: [] });

    expect(result).toEqual({ enabled: false, targets: [] });
  });

  it('adds no default to a single repository when the caller turned hosting off', () => {
    const result = withDefaultCreateDeploymentProvisioning({
      request: { enabled: false, targets: [] },
      projectTypeId: 'react',
      serviceName: 'orders-frontend',
      repoName: 'orders-fe',
      servicePath: '.',
      deploymentProvisioningDefaults: defaults,
    });

    expect(result).toEqual({ enabled: false, targets: [] });
  });

  it('keeps the caller variables when it adds the frontend default', () => {
    const sharedEnv = [
      { lane: 'production' as const, vars: [{ key: 'A', value: 'b' }] },
    ];

    const result = twoHalves({ enabled: true, sharedEnv, targets: [] });

    expect(result?.sharedEnv).toEqual(sharedEnv);
  });
});

describe('root directory against the repo shape', () => {
  // Render reported "Root directory backend does not exist" on a single-app
  // .NET project. The create wizard defaults a backend target's rootDirectory
  // to "backend", but only the microservices scaffold has that folder.
  const backendTarget = (rootDirectory: string) => ({
    enabled: true,
    targets: [
      {
        slot: 'backend' as const,
        provider: 'render',
        ownershipMode: 'flowci_managed' as const,
        rootDirectory,
      },
    ],
  });

  it.each([['standalone'], ['multi'], [undefined]])(
    'points a %s project at the repo root',
    (shape) => {
      const result = withRepoShapeRootDirectory(
        backendTarget('backend'),
        shape,
      );

      expect(result?.targets[0]?.rootDirectory).toBe('.');
    },
  );

  it('leaves microservices alone, where backend/ really exists', () => {
    const result = withRepoShapeRootDirectory(
      backendTarget('backend'),
      'microservices',
    );

    expect(result?.targets[0]?.rootDirectory).toBe('backend');
  });

  it('corrects a frontend slot the same way', () => {
    const request = {
      enabled: true,
      targets: [
        {
          slot: 'frontend' as const,
          provider: 'vercel',
          ownershipMode: 'flowci_managed' as const,
          rootDirectory: 'frontend',
        },
      ],
    };

    expect(
      withRepoShapeRootDirectory(request, 'standalone')?.targets[0]
        ?.rootDirectory,
    ).toBe('.');
  });

  it('does not touch a path someone chose deliberately', () => {
    // A BYO repository may genuinely keep its service in a subdirectory.
    // Only the two literal slot defaults are corrected.
    const result = withRepoShapeRootDirectory(
      backendTarget('services/api'),
      'standalone',
    );

    expect(result?.targets[0]?.rootDirectory).toBe('services/api');
  });
});
