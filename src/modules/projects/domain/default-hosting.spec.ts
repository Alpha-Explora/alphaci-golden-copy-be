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
  forceManagedProvisioning,
  resolveSingleRepoDeploymentSlots,
  withDefaultCreateDeploymentProvisioning,
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

  it('produces deploy jobs for a backend', () => {
    // Render services are per-branch, so its expansion pins uat and main.
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
