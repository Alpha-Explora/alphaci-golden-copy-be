import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { VisualRegressionPort } from '#kernel/ports/visual-regression.port';
import type { AuditEventPublisher } from '#kernel/events/platform-event-publisher.js';
import type { ProjectsRepository } from '../../infrastructure/projects.repository';
import { ProjectVisualService } from './project-visual.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('ProjectVisualService', () => {
  let projects: { findByIdAndUser: jest.Mock; findAppRole: jest.Mock };
  let visual: jest.Mocked<VisualRegressionPort>;
  let audit: { recordProjectEvent: jest.Mock };
  let service: ProjectVisualService;

  beforeEach(() => {
    projects = {
      findByIdAndUser: jest.fn().mockResolvedValue({ repo_full_name: 'o/r' }),
      findAppRole: jest.fn().mockResolvedValue('member'),
    };
    visual = {
      getRun: jest.fn().mockResolvedValue(null),
      readImage: jest.fn().mockResolvedValue(PNG),
      approve: jest.fn().mockResolvedValue(['a.png']),
    };
    audit = { recordProjectEvent: jest.fn().mockResolvedValue(undefined) };
    service = new ProjectVisualService(
      projects as unknown as ProjectsRepository,
      visual,
      audit as unknown as AuditEventPublisher,
    );
  });

  it('returns the empty shape when nothing has been reported', async () => {
    await expect(service.getLatest('p1', 'u1', 'uat')).resolves.toEqual({
      branch: 'uat',
      runId: null,
      canApprove: true,
      snapshots: [],
    });
    expect(visual.getRun).toHaveBeenCalledWith('o/r', 'uat', undefined);
  });

  it('maps facts to the FE shape with relative image urls', async () => {
    visual.getRun.mockResolvedValue({
      branch: 'main',
      runId: 9,
      commitSha: 'abc',
      reportedAt: '2026-10-05T00:00:00.000Z',
      browser: 'chromium',
      snapshots: [
        {
          name: 'a b.png',
          status: 'changed',
          baseline: {
            sha256: 'f'.repeat(64),
            approvedByLogin: 'dev1',
            approvedAt: '2026-10-01T00:00:00.000Z',
            inheritedFrom: 'uat',
          },
          hasActual: true,
          hasDiff: true,
          approved: false,
        },
        {
          name: 'n.png',
          status: 'new',
          baseline: null,
          hasActual: true,
          hasDiff: false,
          approved: false,
        },
        {
          name: 'p.png',
          status: 'passed',
          baseline: null,
          hasActual: false,
          hasDiff: false,
          approved: false,
        },
      ],
    });

    const result = await service.getLatest('p1', 'u1', 'main', 9);

    expect(visual.getRun).toHaveBeenCalledWith('o/r', 'main', 9);
    expect(result).toMatchObject({
      runId: 9,
      commitSha: 'abc',
      browser: 'chromium',
    });
    const [changed, added, passed] = (result as { snapshots: unknown[] })
      .snapshots;
    expect(changed).toEqual({
      name: 'a b.png',
      status: 'changed',
      baselineUrl:
        '/projects/p1/workspace/visual/image?kind=baseline&branch=main&runId=9&name=a%20b.png&v=ffffffffffff',
      actualUrl:
        '/projects/p1/workspace/visual/image?kind=actual&branch=main&runId=9&name=a%20b.png',
      diffUrl:
        '/projects/p1/workspace/visual/image?kind=diff&branch=main&runId=9&name=a%20b.png',
      baselineApprovedBy: 'dev1',
      baselineApprovedAt: '2026-10-01T00:00:00.000Z',
      inheritedFrom: 'uat',
      approved: false,
    });
    expect(added).toMatchObject({
      baselineUrl: null,
      diffUrl: null,
      inheritedFrom: null,
    });
    expect(passed).toMatchObject({
      actualUrl: null,
      diffUrl: null,
      baselineApprovedBy: null,
    });
  });

  it('makes a viewed run that is not the latest read-only', async () => {
    const run = (runId: number) => ({
      branch: 'uat',
      runId,
      commitSha: 'a',
      reportedAt: '',
      browser: 'chromium',
      snapshots: [],
    });
    visual.getRun.mockImplementation((_r, _b, id) =>
      Promise.resolve(run(id ?? 12)),
    );
    await expect(
      service.getLatest('p1', 'u1', 'uat', 9),
    ).resolves.toMatchObject({
      runId: 9,
      canApprove: false,
    });
    await expect(
      service.getLatest('p1', 'u1', 'uat', 12),
    ).resolves.toMatchObject({
      runId: 12,
      canApprove: true,
    });
    await expect(service.getLatest('p1', 'u1', 'uat')).resolves.toMatchObject({
      canApprove: true,
    });
  });

  it('reports canApprove from the allow-list', async () => {
    projects.findAppRole.mockResolvedValue('qa');
    await expect(service.getLatest('p1', 'u1', 'uat')).resolves.toMatchObject({
      canApprove: false,
    });
  });

  it('treats a project the caller cannot see as 404 on every method', async () => {
    projects.findByIdAndUser.mockResolvedValue(null);
    await expect(service.getLatest('p1', 'u1', 'uat')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.getImage('p1', 'u1', {
        kind: 'baseline',
        branch: 'uat',
        name: 'a.png',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.approve('p1', 'u1', 'x', {
        branch: 'uat',
        runId: 1,
        names: ['a.png'],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves image bytes and 404s an absent image', async () => {
    await expect(
      service.getImage('p1', 'u1', {
        kind: 'actual',
        branch: 'uat',
        name: 'a.png',
        runId: 3,
      }),
    ).resolves.toBe(PNG);
    expect(visual.readImage).toHaveBeenCalledWith({
      repoFullName: 'o/r',
      branch: 'uat',
      kind: 'actual',
      name: 'a.png',
      runId: 3,
    });
    visual.readImage.mockResolvedValue(null);
    await expect(
      service.getImage('p1', 'u1', {
        kind: 'diff',
        branch: 'uat',
        name: 'a.png',
        runId: 3,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('approve', () => {
    const input = { branch: 'uat' as const, runId: 9, names: ['a.png'] };

    it.each(['member', 'lead', 'admin'])(
      'lets %s approve and audits it',
      async (role) => {
        projects.findAppRole.mockResolvedValue(role);
        await expect(
          service.approve('p1', 'u1', 'dev1', input),
        ).resolves.toEqual({
          approved: ['a.png'],
        });
        expect(visual.approve).toHaveBeenCalledWith({
          repoFullName: 'o/r',
          branch: 'uat',
          runId: 9,
          names: ['a.png'],
          approvedByUserId: 'u1',
          approvedByLogin: 'dev1',
        });
        expect(audit.recordProjectEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            actorUserId: 'u1',
            projectId: 'p1',
            eventCode: 'visual_baselines_approved',
            metadata: { branch: 'uat', runId: 9, names: ['a.png'] },
          }),
        );
      },
    );

    it.each(['qa', 'auditor'])(
      'refuses %s without approving or auditing',
      async (role) => {
        projects.findAppRole.mockResolvedValue(role);
        await expect(
          service.approve('p1', 'u1', 'x', input),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(visual.approve).not.toHaveBeenCalled();
        expect(audit.recordProjectEvent).not.toHaveBeenCalled();
      },
    );

    it('does not audit when the port refuses the batch', async () => {
      visual.approve.mockRejectedValue(new Error('conflict'));
      await expect(service.approve('p1', 'u1', 'x', input)).rejects.toThrow(
        'conflict',
      );
      expect(audit.recordProjectEvent).not.toHaveBeenCalled();
    });
  });
});
