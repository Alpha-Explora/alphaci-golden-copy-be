import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';

import type { ProjectRequirementsReadinessPort } from '#kernel/ports/project-requirements-readiness.port';
import type { WorkspacesPort } from '#kernel/ports/workspaces.port';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { WorkspaceGateService } from './workspace-gate.service';

function build(
  appRole: string,
  inWorkspace = true,
  { featureCount = 1, ruleEnabled = true } = {},
) {
  const projectsRepository = {
    findAppRole: jest.fn().mockResolvedValue(appRole),
    canCreateInWorkspace: jest.fn().mockResolvedValue(inWorkspace),
  };
  const readiness = {
    isFeatureRuleEnabled: jest.fn().mockReturnValue(ruleEnabled),
    countActiveFeatures: jest
      .fn()
      .mockImplementation((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, featureCount]))),
      ),
  };
  const service = new WorkspaceGateService(
    projectsRepository as unknown as ProjectsRepository,
    undefined as unknown as WorkspacesPort,
    readiness as unknown as ProjectRequirementsReadinessPort,
  );
  return { service, projectsRepository, readiness };
}

describe('WorkspaceGateService repository-create gate', () => {
  it.each(['lead', 'qa'])(
    '%s is refused with 403 REPOSITORY_CREATE_FORBIDDEN, with or without a Project',
    async (role) => {
      const { service } = build(role);
      for (const dp of [undefined, 'dp-1']) {
        const error = await service
          .resolveWorkspaceIdForCreate('user-1', 'ws-1', dp)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'REPOSITORY_CREATE_FORBIDDEN',
          message: 'Developers create repositories inside a Project.',
        });
      }
    },
  );

  it('a member without a Project gets 400 PROJECT_REQUIRED', async () => {
    const { service, projectsRepository } = build('member');
    const error = await service
      .resolveWorkspaceIdForCreate('user-1', 'ws-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: 'PROJECT_REQUIRED',
      message: 'Choose the Project this repository belongs to.',
    });
    expect(projectsRepository.canCreateInWorkspace).not.toHaveBeenCalled();
  });

  it('a member into a Project of a team they belong to passes', async () => {
    const { service } = build('member', true);
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
  });

  it('a member naming a team they are not in is refused (403)', async () => {
    const { service } = build('member', false);
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-other', 'dp-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an admin is unchanged: the Project stays optional', async () => {
    const { service } = build('admin');
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1'),
    ).resolves.toBe('ws-1');
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
  });
});

describe('WorkspaceGateService Feature-before-repository gate', () => {
  it('a member into a Project with no active Feature gets 409 PROJECT_FEATURES_REQUIRED', async () => {
    const { service, projectsRepository, readiness } = build('member', true, {
      featureCount: 0,
    });
    const error = await service
      .resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'PROJECT_FEATURES_REQUIRED',
      message:
        'Your Product owner adds a Feature to this Project before repositories can be created in it.',
      deliveryProjectId: 'dp-1',
    });
    expect(readiness.countActiveFeatures).toHaveBeenCalledWith(['dp-1']);
    // Refused up front: nothing after the gate ran.
    expect(projectsRepository.canCreateInWorkspace).not.toHaveBeenCalled();
  });

  it('a member into a Project with one active Feature passes', async () => {
    const { service } = build('member', true, { featureCount: 1 });
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
  });

  it("only the requested Project counts (another Project's Feature does not)", async () => {
    const { service, readiness } = build('member');
    readiness.countActiveFeatures.mockResolvedValue(new Map([['dp-other', 3]]));
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('an archived Feature does not count (the port reports active ones only)', async () => {
    const { service, readiness } = build('member');
    readiness.countActiveFeatures.mockResolvedValue(new Map([['dp-1', 0]]));
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).rejects.toMatchObject({
      response: { code: 'PROJECT_FEATURES_REQUIRED' },
    });
  });

  it('an admin is exempt and never reads the count', async () => {
    const { service, readiness } = build('admin', true, { featureCount: 0 });
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
    expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
  });

  it('is skipped when the QA capability is off', async () => {
    const { service, readiness } = build('member', true, {
      featureCount: 0,
      ruleEnabled: false,
    });
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).resolves.toBe('ws-1');
    expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
  });

  it('is skipped by callers that run after the repository exists', async () => {
    const { service, readiness } = build('member', true, { featureCount: 0 });
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1', {
        requireFeatures: false,
      }),
    ).resolves.toBe('ws-1');
    expect(readiness.countActiveFeatures).not.toHaveBeenCalled();
  });

  it('role errors still win over the Feature gate (lead refused, PROJECT_REQUIRED)', async () => {
    const lead = build('lead', true, { featureCount: 0 });
    await expect(
      lead.service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const member = build('member', true, { featureCount: 0 });
    await expect(
      member.service.resolveWorkspaceIdForCreate('user-1', 'ws-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lead.readiness.countActiveFeatures).not.toHaveBeenCalled();
    expect(member.readiness.countActiveFeatures).not.toHaveBeenCalled();
  });

  it('fails closed for a member when the readiness port is not wired', async () => {
    const projectsRepository = {
      findAppRole: jest.fn().mockResolvedValue('member'),
      canCreateInWorkspace: jest.fn().mockResolvedValue(true),
    };
    const service = new WorkspaceGateService(
      projectsRepository as unknown as ProjectsRepository,
      undefined as unknown as WorkspacesPort,
      undefined,
    );
    await expect(
      service.resolveWorkspaceIdForCreate('user-1', 'ws-1', 'dp-1'),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
