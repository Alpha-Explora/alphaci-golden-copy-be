import { RenderDeploymentPolicy } from './render-deployment.policy';
import { renderWorkflowFragment } from './render-workflow.fragment';
import type { RenderCostPolicyService } from './render-cost-policy.service';
import type { DeploymentProvisioningTarget } from '../../../core/deployment-provisioning.contract';
import type { WorkflowTargetExpansionInput } from '../../../core/workflow-fragment.contract';
import { RenderCiSecretsService } from './render-ci-secrets.service';
import {
  renderBranchFor,
  RENDER_SERVICE_BRANCHES,
  type RenderServiceBranch,
} from './render-conventions';

/*
 * Provisioning points the Render service at an image; the generated pipeline
 * builds and pushes one. Render can only deploy the image its service names,
 * so if these two disagree nothing the pipeline produces can ever be released.
 *
 * They did disagree, in production, for every managed backend: the service was
 * created for `alphaci-backend-uat-<project>-uat` because provisioning appended
 * the branch to a project name that already ended in it, while the pipeline
 * pushed `alphaci-backend-uat-<project>`. Both halves passed their own tests -
 * there was no test that put them side by side.
 */
describe('Render provisioning and the generated pipeline agree on the image', () => {
  const repoFullName = 'Alphaexplora-Sandbox/myvercel-be';
  const policy = new RenderDeploymentPolicy({} as RenderCostPolicyService);

  const requested = {
    slot: 'backend',
    provider: 'render',
    ownershipMode: 'flowci_managed',
    projectName: 'myvercel-backend',
  } as unknown as DeploymentProvisioningTarget;

  function serviceImagesByBranch(): Record<string, string> {
    const expanded = policy.provisioning.expandTargets({
      target: requested,
      allTargets: [requested],
    });

    const entries: Array<[string, string]> = expanded.map((target) => [
      String(target.branchName),
      policy.provisioning.defaultImageUrl({ repoFullName, target }) ?? '',
    ]);
    return Object.fromEntries(entries);
  }

  function pipelineImagesByBranch(): Record<string, string> {
    const owner = repoFullName.split('/')[0]!.toLowerCase();
    const targets = renderWorkflowFragment.expandTargets!(
      {
        ...requested,
        providerData: { ...requested },
      } as unknown as WorkflowTargetExpansionInput,
      {},
    );

    const entries: Array<[string, string]> = targets.map((target) => [
      String(target.branchName),
      `ghcr.io/${owner}/${String(target.imageName)}`,
    ]);
    return Object.fromEntries(entries);
  }

  it('creates a service for every branch the pipeline builds', () => {
    expect(Object.keys(serviceImagesByBranch()).sort()).toEqual(
      Object.keys(pipelineImagesByBranch()).sort(),
    );
  });

  it('names the same image repository on both sides', () => {
    const services = serviceImagesByBranch();
    const pipeline = pipelineImagesByBranch();

    for (const [branch, serviceImage] of Object.entries(services)) {
      // The tag may differ - Render accepts a different tag on a deploy, and
      // the release path uses the commit tag. The repository may not.
      const [repository, tag] = serviceImage.split(':');
      expect(repository).toBe(pipeline[branch]);
      expect(tag).toBe(branch);
    }
  });

  it('does not repeat the branch inside the image name', () => {
    for (const image of Object.values(serviceImagesByBranch())) {
      // Repository only: the tag is the branch by design, and counting it
      // would make every correct name look duplicated.
      const name = (image.split(':')[0] ?? '').split('/').pop() ?? '';
      expect(name.match(/uat/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(name.match(/main/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

/*
 * The credential half of the same question.
 *
 * The generated deploy job and the secret installer are written in different
 * files, and they used to disagree about which Render secrets existed at all:
 * the installer wrote an account-wide API key that no job ever read. Now the
 * platform performs the release, so neither side may put a hosting credential
 * in a customer repository.
 */
describe('neither half puts a hosting credential in the repository', () => {
  const installer = new RenderCiSecretsService({
    setActionsSecretStrict: jest.fn(),
  } as never);

  const requested = {
    slot: 'backend',
    provider: 'render',
    ownershipMode: 'flowci_managed',
    projectName: 'myvercel-backend',
  } as unknown as DeploymentProvisioningTarget;

  it('installs only the service address, named after the branch', () => {
    for (const branch of RENDER_SERVICE_BRANCHES) {
      expect(installer.renderSecretNames('backend', branch)).toEqual({
        healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branch.toUpperCase()}`,
      });
    }
  });

  it('emits deploy jobs that ask for no Render secret', () => {
    const targets = renderWorkflowFragment.expandTargets!(
      {
        ...requested,
        providerData: { ...requested },
      } as unknown as WorkflowTargetExpansionInput,
      {},
    );

    expect(targets.length).toBe(RENDER_SERVICE_BRANCHES.length);
    for (const target of targets) {
      const branch = target.branchName as RenderServiceBranch;
      const fragment = renderWorkflowFragment.build(target, branch, {
        serviceName: 'demo',
        servicePath: '.',
        centralWorkflowRef: 'v1',
      });
      expect(JSON.stringify(fragment?.jobs)).not.toMatch(/secrets\.RENDER/i);
    }
  });

  it('never falls back to a branch Render has no service for', () => {
    expect(RENDER_SERVICE_BRANCHES).toContain(renderBranchFor('nonsense'));
    expect(renderBranchFor('main')).toBe('main');
    expect(renderBranchFor('uat')).toBe('uat');
    // dev is not hosted, so it resolves like any other unknown branch.
    expect(RENDER_SERVICE_BRANCHES).toContain(renderBranchFor('dev'));
    // The fallback is never production: guessing wrong must not point a deploy
    // at the customer's live environment.
    expect(renderBranchFor('something-else')).not.toBe('main');
    expect(renderBranchFor('dev')).not.toBe('main');
  });
});
