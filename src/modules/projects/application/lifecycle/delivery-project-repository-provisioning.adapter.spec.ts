import { BadRequestException } from '@nestjs/common';

import type { ProjectProvisioningApplicationService } from './project-provisioning-application.service';
import { DeliveryProjectRepositoryProvisioningAdapter } from './delivery-project-repository-provisioning.adapter';

const RESULT = {
  id: 'project-1',
  repoFullName: 'org/new-repo',
  repoUrl: 'https://github.com/org/new-repo',
  status: 'provisioned' as const,
  workflowPath: '.github/workflows/ci.yml',
  workflowFiles: [],
  githubCommitSha: 'abc',
  githubCommitUrl: null,
  projectTypeId: 'nextjs-web',
  workflowRecipeId: 'standard',
  branchesCreated: ['dev', 'uat'],
  deploymentProvisioning: {
    status: 'completed' as const,
    targets: [],
  },
};

function setup() {
  const createProject = jest.fn().mockResolvedValue(RESULT);
  const adapter = new DeliveryProjectRepositoryProvisioningAdapter({
    createProject,
  } as unknown as ProjectProvisioningApplicationService);
  return { adapter, createProject };
}

const base = {
  userId: 'dev-1',
  userLogin: 'dev-login',
  githubAccessToken: 'token',
  workspaceId: 'group-1',
  deliveryProjectId: 'dp-1',
  repoName: 'new-repo',
  visibility: 'private' as const,
  projectTypeId: 'nextjs-web',
  serviceName: 'new-repo',
};

describe('DeliveryProjectRepositoryProvisioningAdapter', () => {
  it('runs the wizard provisioning, filed under the Project, and maps the outcome', async () => {
    const { adapter, createProject } = setup();
    const result = await adapter.provisionRepository(base);

    expect(createProject).toHaveBeenCalledWith(
      'dev-1',
      'dev-login',
      'token',
      expect.objectContaining({
        repoName: 'new-repo',
        visibility: 'private',
        repoShape: 'standalone',
        projectTypeId: 'nextjs-web',
        serviceName: 'new-repo',
        workspaceId: 'group-1',
        deliveryProjectId: 'dp-1',
      }),
    );
    expect(result).toEqual({
      provisionedProjectId: 'project-1',
      repoFullName: 'org/new-repo',
      repoUrl: 'https://github.com/org/new-repo',
      workflowPath: '.github/workflows/ci.yml',
      branchesCreated: ['dev', 'uat'],
      deploymentProvisioning: RESULT.deploymentProvisioning,
    });
  });

  it('leaves deploymentProvisioning off the request when none is given so the managed defaults apply', async () => {
    const { adapter, createProject } = setup();
    await adapter.provisionRepository(base);
    expect(createProject.mock.calls[0]?.[3]).not.toHaveProperty(
      'deploymentProvisioning',
    );
  });

  it('forwards a valid hosting request', async () => {
    const { adapter, createProject } = setup();
    await adapter.provisionRepository({
      ...base,
      deploymentProvisioning: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
          },
        ],
      },
    });
    expect(createProject.mock.calls[0]?.[3]).toMatchObject({
      deploymentProvisioning: {
        enabled: true,
        targets: [{ slot: 'frontend', provider: 'vercel' }],
      },
    });
  });

  it('rejects an invalid hosting request with 400 BEFORE anything is created on GitHub', async () => {
    const { adapter, createProject } = setup();
    await expect(
      adapter.provisionRepository({
        ...base,
        deploymentProvisioning: {
          enabled: true,
          targets: [{ slot: 'database', provider: 'Vercel!' }],
        } as never,
      }),
    ).rejects.toMatchObject({
      response: { code: 'DEPLOYMENT_PROVISIONING_INVALID' },
    });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('rejects an unknown hosting field (same forbidNonWhitelisted rule as POST /projects)', async () => {
    const { adapter, createProject } = setup();
    await expect(
      adapter.provisionRepository({
        ...base,
        deploymentProvisioning: {
          enabled: true,
          targets: [],
          surprise: true,
        } as never,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('lets a provisioning failure surface (the wizard compensates its own half-created repo)', async () => {
    const { adapter, createProject } = setup();
    createProject.mockRejectedValue(new Error('GitHub 502'));
    await expect(adapter.provisionRepository(base)).rejects.toThrow(
      'GitHub 502',
    );
  });
});
