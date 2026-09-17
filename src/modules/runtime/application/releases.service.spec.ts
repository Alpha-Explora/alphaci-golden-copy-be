import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { ReleasesService } from './releases.service';
import type { DeploymentTargetSummary } from '../core/deployments.types';
import type {
  ProviderReleaseHandle,
  ProviderReleaser,
} from './ports/provider-releaser.port';
import type { DeploymentTargetsRepository } from '../infrastructure/repositories/deployment-targets.repository';

function target(
  overrides: Partial<DeploymentTargetSummary> = {},
): DeploymentTargetSummary {
  return {
    id: 'target-uat',
    projectId: 'project-1',
    slot: 'backend',
    ownershipMode: 'flowci_managed',
    provider: 'render',
    providerConnectionId: null,
    providerProjectId: 'srv-1',
    providerProjectName: 'demo-backend-uat',
    repoFullName: 'org/demo-be',
    branchName: 'uat',
    rootDirectory: null,
    buildCommand: null,
    startCommand: null,
    environmentMap: {},
    deploymentStrategy: 'render_image_pushed',
    providerMetadata: { renderServiceUrl: 'https://demo-uat.onrender.com' },
    status: 'active',
    ...overrides,
  } as DeploymentTargetSummary;
}

function build(options: {
  targets?: DeploymentTargetSummary[];
  releaser?: Partial<ProviderReleaser> | null;
  enabled?: boolean;
}) {
  const handle: ProviderReleaseHandle = {
    providerReleaseId: 'dep-9',
    status: 'in_progress',
    serviceUrl: 'https://demo-uat.onrender.com',
    message: 'Render status: build_in_progress',
  };

  const releaser = {
    provider: 'render',
    supports: () => true,
    start: jest.fn().mockResolvedValue(handle),
    check: jest.fn().mockResolvedValue({ ...handle, status: 'live' }),
    ...(options.releaser ?? {}),
  } as ProviderReleaser & {
    start: jest.Mock;
    check: jest.Mock;
  };

  const repository = {
    listDeploymentTargets: jest
      .fn()
      .mockResolvedValue(options.targets ?? [target()]),
  } as unknown as DeploymentTargetsRepository;

  const service = new ReleasesService(
    repository,
    { get: () => (options.releaser === null ? undefined : releaser) },
    {
      getOrThrow: () => ({
        envProvisioning: { enabled: options.enabled ?? true },
      }),
    } as never,
  );

  return { service, releaser, repository };
}

describe('ReleasesService', () => {
  const request = {
    projectId: 'project-1',
    slot: 'backend',
    branch: 'uat',
    commitSha: 'abc1234',
    artifact: 'ghcr.io/org/img:sha-abc1234',
  };

  it('releases to the target that serves this slot and branch', async () => {
    const { service, releaser } = build({
      targets: [
        target({ id: 'target-main', branchName: 'main' }),
        target({ id: 'target-uat', branchName: 'uat' }),
      ],
    });

    const view = await service.startRelease(request);

    expect(releaser.start).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ id: 'target-uat' }),
        artifact: 'ghcr.io/org/img:sha-abc1234',
        commitSha: 'abc1234',
      }),
    );
    // The id carries the target so a later poll can find it again without a
    // stored row.
    expect(view.releaseId).toBe('target-uat.dep-9');
    expect(view.status).toBe('in_progress');
    expect(view.serviceUrl).toBe('https://demo-uat.onrender.com');
  });

  it('says which branches do have a target when the branch has none', async () => {
    const { service } = build({
      targets: [target({ id: 'target-main', branchName: 'main' })],
    });

    await expect(
      service.startRelease({ ...request, branch: 'dev' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.startRelease({ ...request, branch: 'dev' }),
    ).rejects.toThrow(/no backend deployment target for 'dev'.*backend\/main/s);
  });

  it('refuses a provider that deploys from the pipeline itself', async () => {
    const { service } = build({
      targets: [target({ provider: 'vercel', slot: 'backend' })],
      releaser: null,
    });

    await expect(service.startRelease(request)).rejects.toThrow(
      /vercel deployments are performed by the pipeline/,
    );
  });

  it('refuses a target its provider does not handle', async () => {
    const { service } = build({ releaser: { supports: () => false } });

    await expect(service.startRelease(request)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('reads a release back through the target in its id', async () => {
    const { service, releaser } = build({});

    const view = await service.getRelease({
      projectId: 'project-1',
      releaseId: 'target-uat.dep-9',
    });

    expect(releaser.check).toHaveBeenCalledWith({
      target: expect.objectContaining({ id: 'target-uat' }),
      providerReleaseId: 'dep-9',
    });
    expect(view.status).toBe('live');
  });

  it('does not read a release whose target belongs to another project', async () => {
    // The project comes from the authenticated token, so a forged id must not
    // reach another project's target.
    const { service, releaser } = build({});

    await expect(
      service.getRelease({
        projectId: 'project-1',
        releaseId: 'someone-elses-target.dep-9',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(releaser.check).not.toHaveBeenCalled();
  });

  it('rejects a malformed release id', async () => {
    const { service } = build({});

    await expect(
      service.getRelease({ projectId: 'project-1', releaseId: 'nonsense' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses to release when provisioning is disabled', async () => {
    const { service } = build({ enabled: false });

    await expect(service.startRelease(request)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
