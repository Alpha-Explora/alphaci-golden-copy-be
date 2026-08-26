import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { CiController } from './ci.controller';
import type { CiService } from './ci.service';
import type { CiReportsService } from './ci-reports.service';

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
});
