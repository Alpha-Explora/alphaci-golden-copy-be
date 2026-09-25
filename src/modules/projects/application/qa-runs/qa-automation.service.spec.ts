import { QaAutomationService } from './qa-automation.service';
import type {
  CiStageResult,
  CiStageResultsLookup,
} from '#kernel/ports/ci-stage-results.port';

const ciStageResult = (
  overrides: Partial<CiStageResult> = {},
): CiStageResult => ({
  stage: 'verify',
  status: 'success',
  runId: 1,
  runUrl: 'https://github.com/acme/repo/actions/runs/1',
  reportedAt: '2026-09-25T00:00:00.000Z',
  tests: null,
  ...overrides,
});

describe('QaAutomationService.forRun', () => {
  it('asks the port for exactly (repoFullName, branch, commitSha, [quality, verify])', async () => {
    const latestStageReports = jest.fn().mockResolvedValue([]);
    const stageResults = {
      latestStageReports,
    } as unknown as CiStageResultsLookup;
    const service = new QaAutomationService(stageResults);

    await service.forRun('acme/orders-api', 'main', 'a'.repeat(40));

    expect(latestStageReports).toHaveBeenCalledWith({
      repoFullName: 'acme/orders-api',
      branch: 'main',
      commitSha: 'a'.repeat(40),
      stages: ['quality', 'verify'],
    });
  });

  it('maps a missing stage to null and slots verify/quality by stage id, not array order', async () => {
    const stageResults = {
      latestStageReports: jest
        .fn()
        .mockResolvedValue([ciStageResult({ stage: 'quality', runId: 10 })]),
    } as unknown as CiStageResultsLookup;
    const service = new QaAutomationService(stageResults);

    const automation = await service.forRun('acme/orders-api', 'main', 'sha');

    expect(automation.verify).toBeNull();
    expect(automation.quality).toMatchObject({ stage: 'quality', runId: 10 });
  });

  it('passes the port row through field-for-field, including tests', async () => {
    const report = ciStageResult({
      stage: 'verify',
      status: 'failure',
      runId: 7,
      tests: {
        total: 2,
        passed: 1,
        failed: 1,
        failures: [{ name: 'e2e/a.spec.ts > x', message: 'boom' }],
        failuresTruncated: false,
      },
    });
    const stageResults = {
      latestStageReports: jest.fn().mockResolvedValue([report]),
    } as unknown as CiStageResultsLookup;
    const service = new QaAutomationService(stageResults);

    const automation = await service.forRun('acme/orders-api', 'main', 'sha');

    expect(automation.verify).toEqual({
      stage: 'verify',
      status: 'failure',
      runId: 7,
      runUrl: report.runUrl,
      reportedAt: report.reportedAt,
      tests: report.tests,
    });
  });
});
