import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { ProjectLifecycleService } from './project-lifecycle.service';
import type { PlatformAppRole } from '#kernel/ports/platform-admin.port';

describe('ProjectLifecycleService.disableSonarAutomaticAnalysis', () => {
  const build = (
    overrides: {
      project?: unknown;
      appRole?: PlatformAppRole;
      sonar?: null;
      sonarResult?: unknown;
    } = {},
  ) => {
    const projectsRepository = {
      findByIdAndUser: jest
        .fn()
        .mockResolvedValue(
          'project' in overrides
            ? overrides.project
            : { id: 'project-1', repo_full_name: 'tone/shop-fe' },
        ),
      findAppRole: jest.fn().mockResolvedValue(overrides.appRole ?? 'lead'),
    };
    const sonar =
      overrides.sonar === null
        ? undefined
        : {
            disableAutomaticAnalysis: jest.fn().mockResolvedValue(
              overrides.sonarResult ?? {
                projectKey: 'tone_shop-fe',
                disabled: true,
                message: 'Automatic Analysis is disabled.',
              },
            ),
          };
    const auditEventsService = { recordProjectEvent: jest.fn() };
    const service = new ProjectLifecycleService(
      {} as never,
      projectsRepository as never,
      {} as never,
      auditEventsService as never,
      undefined,
      undefined,
      undefined,
      sonar as never,
    );
    return { service, sonar, auditEventsService };
  };

  it('switches Automatic Analysis off for the project key and records it', async () => {
    const { service, sonar, auditEventsService } = build();

    await expect(
      service.disableSonarAutomaticAnalysis('project-1', 'user-1'),
    ).resolves.toEqual({
      projectKey: 'tone_shop-fe',
      disabled: true,
      message: 'Automatic Analysis is disabled.',
    });
    expect(sonar!.disableAutomaticAnalysis).toHaveBeenCalledWith(
      'tone_shop-fe',
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventCode: 'project_sonar_autoscan_disabled' }),
    );
  });

  it('returns a refusal in the body and records the failure', async () => {
    const { service, auditEventsService } = build({
      sonarResult: {
        projectKey: 'tone_shop-fe',
        disabled: false,
        message: 'SonarCloud refused to disable Automatic Analysis (403)',
      },
    });

    await expect(
      service.disableSonarAutomaticAnalysis('project-1', 'user-1'),
    ).resolves.toMatchObject({ disabled: false });
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCode: 'project_sonar_autoscan_disable_failed',
      }),
    );
  });

  it.each<PlatformAppRole>(['member', 'qa'])(
    'refuses a %s with PROJECT_ROLE_FORBIDDEN',
    async (appRole) => {
      const { service, sonar } = build({ appRole });

      await expect(
        service.disableSonarAutomaticAnalysis('project-1', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sonar!.disableAutomaticAnalysis).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for a project the user cannot see', async () => {
    const { service } = build({ project: null });

    await expect(
      service.disableSonarAutomaticAnalysis('project-x', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('says so when SonarCloud is not wired on this server', async () => {
    const { service } = build({ sonar: null });

    await expect(
      service.disableSonarAutomaticAnalysis('project-1', 'user-1'),
    ).resolves.toEqual({
      projectKey: '',
      disabled: false,
      message: 'SonarCloud repair is not available on this server.',
    });
  });
});
