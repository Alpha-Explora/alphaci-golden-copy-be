import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import type { Request } from 'express';

import { CiController } from './ci.controller';
import type { CiService } from '../application/ci.service';
import type { CiReportsService } from '../application/ci-reports.service';

const REPORT = {
  schemaVersion: 'ci-run-report/v1',
  generatedAt: '2026-10-09T09:00:00.000Z',
  repoFullName: 'acme/orders-api',
  branch: 'uat',
  commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  startedAt: '2026-10-09T07:55:00.000Z',
  overallStatus: 'failure',
  summary: { stages: 1, passed: 0, failed: 1, inProgress: 0, notRun: 0 },
  failures: [
    {
      stage: 'quality',
      severity: 'error',
      title: 'Tests failed',
      detail: 'd',
      hint: 'h',
      items: [],
    },
  ],
  stages: [],
};

const RUN_QUERY = {
  repoFullName: 'acme/orders-api',
  branch: 'uat',
  commitSha: REPORT.commitSha,
};

async function bodyOf(file: StreamableFile): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const makeService = () =>
  ({
    validateRun: jest.fn().mockResolvedValue({
      authorized: true,
      projectId: 'project-1',
      repoFullName: 'owner/repo',
      stage: 'quality',
    }),
  }) as unknown as CiService;

const makeReportsService = () =>
  ({
    ingestReport: jest.fn().mockResolvedValue({ received: true }),
    getRuns: jest.fn().mockResolvedValue({ runs: [] }),
    getRunReport: jest.fn().mockResolvedValue(REPORT),
  }) as unknown as CiReportsService;

const makeRequest = (userId?: string): Request =>
  ({
    session: {
      user: userId ? { id: userId } : undefined,
      userId,
    },
  }) as unknown as Request;

describe('CiController', () => {
  let service: CiService;
  let reportsService: CiReportsService;
  let controller: CiController;

  beforeEach(() => {
    service = makeService();
    reportsService = makeReportsService();
    controller = new CiController(service, reportsService);
  });

  // ─── POST /ci/validate ───────────────────────────────────────────────────

  it('validates a bearer token against repo and stage metadata', async () => {
    const result = await controller.validate('Bearer aci_valid-token', {
      repo: 'owner/repo',
      stage: 'quality',
      workflowRunId: '12345',
      headSha: 'abc123',
    });

    expect(service.validateRun).toHaveBeenCalledWith({
      token: 'aci_valid-token',
      repoFullName: 'owner/repo',
      stage: 'quality',
      workflowRunId: '12345',
      headSha: 'abc123',
    });
    expect(result.authorized).toBe(true);
  });

  it('rejects requests without a bearer token', async () => {
    await expect(
      controller.validate(undefined, { repo: 'owner/repo', stage: 'gate' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  // ─── POST /ci/report ─────────────────────────────────────────────────────

  it('accepts a valid report and returns received: true', async () => {
    const body = {
      repoFullName: 'owner/repo',
      branch: 'test',
      commitSha: 'abc123',
      runId: 12345,
      stage: 'quality' as const,
      conclusion: 'success' as const,
      results: { tests: { passed: 10, failed: 0, total: 10 } },
    };

    const result = await controller.ingestReport(
      'Bearer aci_valid-token',
      body,
    );

    expect(service.validateRun).toHaveBeenCalledWith({
      token: 'aci_valid-token',
      repoFullName: 'owner/repo',
      stage: 'quality',
    });
    expect(reportsService.ingestReport).toHaveBeenCalledWith(body);
    expect(result).toEqual({ received: true });
  });

  it('rejects report requests without a bearer token', async () => {
    await expect(
      controller.ingestReport(undefined, {
        repoFullName: 'owner/repo',
        branch: 'test',
        commitSha: 'abc123',
        runId: 1,
        stage: 'quality',
        conclusion: 'success',
        results: {},
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('propagates invalid CI token as ForbiddenException from service', async () => {
    (service.validateRun as jest.Mock).mockRejectedValueOnce(
      new ForbiddenException('CI token not authorized'),
    );

    await expect(
      controller.ingestReport('Bearer aci_bad', {
        repoFullName: 'other/repo',
        branch: 'test',
        commitSha: 'abc123',
        runId: 1,
        stage: 'access',
        conclusion: 'failure',
        results: {},
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('propagates NotFoundException when repo is not registered', async () => {
    (service.validateRun as jest.Mock).mockResolvedValueOnce({
      authorized: true,
      projectId: 'p-1',
      repoFullName: 'owner/repo',
      stage: 'access',
    });
    (reportsService.ingestReport as jest.Mock).mockRejectedValueOnce(
      new NotFoundException('No provisioned project found'),
    );

    await expect(
      controller.ingestReport('Bearer aci_valid', {
        repoFullName: 'unregistered/repo',
        branch: 'test',
        commitSha: 'abc',
        runId: 9,
        stage: 'access',
        conclusion: 'failure',
        results: {},
      }),
    ).rejects.toThrow(NotFoundException);
  });

  // ─── GET /ci/runs ────────────────────────────────────────────────────────

  it('returns runs for an authenticated user that owns the repo', async () => {
    const runsPayload = {
      runs: [
        {
          runId: 12345,
          repoFullName: 'owner/repo',
          branch: 'test',
          commitSha: 'abc',
          startedAt: '2026-06-14T00:00:00Z',
          overallStatus: 'success',
          stages: [],
        },
      ],
    };
    (reportsService.getRuns as jest.Mock).mockResolvedValueOnce(runsPayload);

    const result = await controller.getRuns(makeRequest('user-1'), {
      repoFullName: 'owner/repo',
    });

    expect(reportsService.getRuns).toHaveBeenCalledWith(
      'user-1',
      'owner/repo',
      undefined,
      undefined,
      undefined,
    );
    expect(result).toEqual(runsPayload);
  });

  it('passes pagination options through when listing runs', async () => {
    await controller.getRuns(makeRequest('user-1'), {
      repoFullName: 'owner/repo',
      limit: 25,
      offset: 50,
    });

    expect(reportsService.getRuns).toHaveBeenCalledWith(
      'user-1',
      'owner/repo',
      25,
      50,
      undefined,
    );
  });

  it('passes the workspaceId team scope through', async () => {
    await controller.getRuns(makeRequest('user-1'), {
      workspaceId: '11111111-1111-4111-8111-111111111111',
    });

    expect(reportsService.getRuns).toHaveBeenCalledWith(
      'user-1',
      undefined,
      undefined,
      undefined,
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('throws UnauthorizedException when no session user present', async () => {
    await expect(
      controller.getRuns(makeRequest(), { repoFullName: 'owner/repo' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('propagates ForbiddenException when user does not own repo', async () => {
    (reportsService.getRuns as jest.Mock).mockRejectedValueOnce(
      new ForbiddenException('Not your repo'),
    );

    await expect(
      controller.getRuns(makeRequest('user-2'), { repoFullName: 'owner/repo' }),
    ).rejects.toThrow(ForbiddenException);
  });

  // ─── GET /ci/runs/report ─────────────────────────────────────────────────

  it('downloads the run report as JSON by default, named for the repo, branch and commit', async () => {
    const file = await controller.getRunReport(
      makeRequest('user-1'),
      RUN_QUERY,
    );

    expect(reportsService.getRunReport).toHaveBeenCalledWith(
      'user-1',
      'acme/orders-api',
      'uat',
      REPORT.commitSha,
    );
    expect(file.getHeaders().type).toBe('application/json; charset=utf-8');
    expect(file.getHeaders().disposition).toBe(
      'attachment; filename="CI-Results-orders-api-uat-a1b2c3d.json"',
    );
    expect(JSON.parse(await bodyOf(file))).toMatchObject({
      schemaVersion: 'ci-run-report/v1',
    });
  });

  it.each(['md', 'markdown'] as const)(
    'downloads Markdown for format=%s',
    async (format) => {
      const file = await controller.getRunReport(makeRequest('user-1'), {
        ...RUN_QUERY,
        format,
      });

      expect(file.getHeaders().type).toBe('text/markdown; charset=utf-8');
      expect(file.getHeaders().disposition).toContain('.md"');
      expect(await bodyOf(file)).toContain(
        '# CI results: acme/orders-api · uat @ a1b2c3d',
      );
    },
  );

  it('rejects a run report request without a session user', async () => {
    await expect(
      controller.getRunReport(makeRequest(), RUN_QUERY),
    ).rejects.toThrow(UnauthorizedException);
    expect(reportsService.getRunReport).not.toHaveBeenCalled();
  });

  it('propagates ForbiddenException and NotFoundException from the service', async () => {
    (reportsService.getRunReport as jest.Mock)
      .mockRejectedValueOnce(new ForbiddenException('nope'))
      .mockRejectedValueOnce(new NotFoundException('none'));

    await expect(
      controller.getRunReport(makeRequest('user-1'), RUN_QUERY),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.getRunReport(makeRequest('user-1'), RUN_QUERY),
    ).rejects.toThrow(NotFoundException);
  });
});
