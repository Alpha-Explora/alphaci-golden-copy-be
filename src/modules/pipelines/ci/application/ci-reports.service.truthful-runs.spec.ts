import { CiReportsService } from './ci-reports.service';
import type { DatabaseService } from '#kernel/db/database.service';
import type { ProjectVisibilityLookup } from '#kernel/ports/project-visibility.port';
import type {
  CiRunReportRow,
  CiRunReportsRepository,
} from '../infrastructure/ci-run-reports.repository';

/*
 * Runs that tell the truth: how stored rows read back, so existing history
 * benefits from the fixes without a backfill, and how new reports are stored.
 */

const makeDatabaseService = () =>
  ({
    query: jest.fn(),
  }) as unknown as DatabaseService;

const makeRunReportsRepository = () =>
  ({
    upsert: jest.fn(),
    findRecentByRepo: jest.fn(),
    findRecentByRepos: jest.fn(),
    findByRepoBranchSha: jest.fn(),
  }) as unknown as CiRunReportsRepository;

const makeProjectVisibility = (): ProjectVisibilityLookup => ({
  isRepoVisibleToUser: jest.fn().mockResolvedValue(true),
  listVisibleRepoNames: jest.fn().mockResolvedValue(['acme/orders-api']),
});

function row(overrides: Partial<CiRunReportRow>): CiRunReportRow {
  return {
    id: 'id',
    user_id: 'user-1',
    repo_full_name: 'acme/orders-api',
    branch: 'uat',
    commit_sha: 'sha-1',
    run_id: '1',
    stage: 'access',
    status: 'success',
    results: {},
    friendly_messages: [],
    raw_logs: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const ESC = String.fromCharCode(27);

describe('CiReportsService.getRuns, truthful runs', () => {
  let runReportsRepository: CiRunReportsRepository;
  let service: CiReportsService;

  const groupsOf = async (rows: CiRunReportRow[]) => {
    (runReportsRepository.findRecentByRepos as jest.Mock).mockResolvedValueOnce(
      rows,
    );
    return (await service.getRuns('user-1')).runs;
  };

  beforeEach(() => {
    runReportsRepository = makeRunReportsRepository();
    service = new CiReportsService(
      makeDatabaseService(),
      runReportsRepository,
      makeProjectVisibility(),
    );
  });

  describe('verify on dev', () => {
    it('is not applicable, and a green dev run reads as success instead of failure', async () => {
      const [run] = await groupsOf([
        row({ branch: 'dev', stage: 'package', run_id: '3' }),
        row({ branch: 'dev', stage: 'quality', run_id: '2' }),
        row({ branch: 'dev', stage: 'access', run_id: '1' }),
      ]);

      const byStage = new Map(run!.stages.map((s) => [s.stage, s]));
      expect(byStage.get('verify')?.status).toBe('not_applicable');
      expect(byStage.get('verify')?.friendlyMessages).toEqual([]);
      expect(run!.overallStatus).toBe('success');
    });

    it('still stalls verify on uat, where it should have reported', async () => {
      const [run] = await groupsOf([
        row({ branch: 'uat', stage: 'package', run_id: '3' }),
        row({ branch: 'uat', stage: 'quality', run_id: '2' }),
        row({ branch: 'uat', stage: 'access', run_id: '1' }),
      ]);

      expect(run!.stages.find((s) => s.stage === 'verify')?.status).toBe(
        'stalled',
      );
      expect(run!.overallStatus).toBe('failure');
    });
  });

  describe('pull request merge refs', () => {
    it('are left out of the runs rather than shown red', async () => {
      const runs = await groupsOf([
        row({ branch: '7/merge', stage: 'access', run_id: '9' }),
        row({ branch: 'dev', stage: 'access', run_id: '1' }),
      ]);

      expect(runs.map((r) => r.branch)).toEqual(['dev']);
    });

    it('does not mistake a branch that merely contains merge for one', async () => {
      const runs = await groupsOf([
        row({ branch: 'feature/merge', stage: 'access', run_id: '9' }),
        row({ branch: 'release/7/merge-fix', stage: 'access', run_id: '8' }),
      ]);

      expect(runs.map((r) => r.branch).sort()).toEqual([
        'feature/merge',
        'release/7/merge-fix',
      ]);
    });
  });

  describe('a verify stage that was skipped on purpose', () => {
    const reason =
      'Nothing was deployed for uat: VERCEL_ALIAS is not set - provision hosting in ALPHACI.';
    const skippedRow = (overrides: Partial<CiRunReportRow> = {}) =>
      row({
        branch: 'uat',
        stage: 'verify',
        run_id: '4',
        status: 'success',
        results: { skipped: { reason } },
        ...overrides,
      });
    const earlier = () => [
      row({ branch: 'uat', stage: 'package', run_id: '3' }),
      row({ branch: 'uat', stage: 'quality', run_id: '2' }),
      row({ branch: 'uat', stage: 'access', run_id: '1' }),
    ];

    it('reads back as not applicable with the reason, not as a pass', async () => {
      const [run] = await groupsOf([skippedRow(), ...earlier()]);

      const verify = run!.stages.find((s) => s.stage === 'verify');
      expect(verify?.status).toBe('not_applicable');
      expect(verify?.friendlyMessages[0]).toMatchObject({
        severity: 'info',
        detail: reason,
      });
      expect(verify?.results).toBeUndefined();
      expect(run!.overallStatus).toBe('success');
    });

    it('does not turn an ordinary success into a skip', async () => {
      const [run] = await groupsOf([skippedRow({ results: {} }), ...earlier()]);

      expect(run!.stages.find((s) => s.stage === 'verify')?.status).toBe(
        'success',
      );
    });
  });

  describe('stored messages are cleaned on read', () => {
    const quality = (overrides: Partial<CiRunReportRow>) =>
      row({ branch: 'dev', stage: 'quality', run_id: '2', ...overrides });

    const messageOf = (
      run: Awaited<ReturnType<typeof groupsOf>>[number] | undefined,
      stage: 'quality' | 'verify',
    ) => run!.stages.find((s) => s.stage === stage)!.friendlyMessages[0]!;

    it('strips ANSI escape codes written before ingest cleaned them', async () => {
      const [run] = await groupsOf([
        quality({
          status: 'failure',
          friendly_messages: [
            {
              severity: 'error',
              title: '1 test(s) failed',
              detail: `${ESC}[31mExpected${ESC}[39m: 1`,
              hint: '',
              items: [{ label: `${ESC}[2mexpect(page)${ESC}[22m`, sub: 'x' }],
            },
          ],
        }),
      ]);

      const message = messageOf(run, 'quality');
      expect(message.detail).toBe('Expected: 1');
      expect(message.items![0]!.label).toBe('expect(page)');
    });

    it('drops a null line number from a stored location', async () => {
      const [run] = await groupsOf([
        quality({
          status: 'failure',
          friendly_messages: [
            {
              severity: 'error',
              title: 'x',
              detail: 'x',
              hint: '',
              items: [{ label: 'Program.cs:null', sub: 'Await RunAsync' }],
            },
          ],
        }),
      ]);

      expect(messageOf(run, 'quality').items![0]!.label).toBe('Program.cs');
    });

    it('strips escape codes from the returned figures too', async () => {
      const [run] = await groupsOf([
        quality({
          status: 'failure',
          friendly_messages: [
            { severity: 'error', title: 'x', detail: 'x', hint: '' },
          ],
          results: {
            tests: {
              passed: 0,
              failed: 1,
              total: 1,
              failures: [{ name: 't', message: `${ESC}[31mboom${ESC}[39m` }],
            },
          },
        }),
      ]);

      expect(
        run!.stages.find((s) => s.stage === 'quality')!.results?.tests
          ?.failures?.[0]?.message,
      ).toBe('boom');
    });

    it('puts the real copy back on a verify failure filed as "Tests failed"', async () => {
      const job = 'api-tests-uat / API Tests (orders) > Wait For Deployment';
      const [run] = await groupsOf([
        row({
          branch: 'uat',
          stage: 'verify',
          run_id: '4',
          status: 'failure',
          raw_logs: `Failed GitHub Actions job: ${job}`,
          friendly_messages: [
            {
              severity: 'error',
              title: 'Tests failed',
              detail: 'GitHub reported this failed job for the verify stage.',
              hint: 'Run the failing test command locally, fix the first failure, then re-run the workflow.',
              items: [{ label: job }],
            },
          ],
        }),
      ]);

      const message = messageOf(run, 'verify');
      expect(message.title).toBe('The deployment never became healthy');
      expect(message.hint).not.toContain('locally');
      // The detail and the items are the original's, untouched.
      expect(message.items![0]!.label).toBe(job);
    });

    it('leaves a genuine verify test failure alone', async () => {
      const [run] = await groupsOf([
        row({
          branch: 'uat',
          stage: 'verify',
          run_id: '4',
          status: 'failure',
          raw_logs:
            'Failed GitHub Actions job: api-tests-uat / API Tests (orders) > Run Bruno collection',
          friendly_messages: [
            {
              severity: 'error',
              title: 'Tests failed',
              detail: 'd',
              hint: 'h',
            },
          ],
        }),
      ]);

      expect(messageOf(run, 'verify').title).toBe('Tests failed');
    });
  });
});

describe('CiReportsService.ingestReport, truthful reports', () => {
  const body = (overrides: Record<string, unknown>) =>
    ({
      repoFullName: 'acme/orders-api',
      branch: 'uat',
      commitSha: 'sha-1',
      runId: 4,
      stage: 'verify',
      conclusion: 'success',
      results: {},
      ...overrides,
    }) as never;

  const setup = () => {
    const repository = makeRunReportsRepository();
    const database = makeDatabaseService();
    (database.query as jest.Mock).mockResolvedValue({
      rows: [{ user_id: 'user-1' }],
    });
    const service = new CiReportsService(
      database,
      repository,
      makeProjectVisibility(),
    );
    return { repository, service };
  };

  it('stores a skipped stage as a success carrying the reason, so no migration is needed', async () => {
    const { repository, service } = setup();

    await service.ingestReport(
      body({
        results: { skipped: { reason: 'Nothing was deployed for uat' } },
      }),
    );

    const call = (repository.upsert as jest.Mock).mock.calls[0]![0] as {
      status: string;
      results: Record<string, unknown>;
      friendlyMessages: { severity: string; detail: string }[];
    };
    expect(call.status).toBe('success');
    expect(call.results['skipped']).toEqual({
      reason: 'Nothing was deployed for uat',
    });
    expect(call.friendlyMessages).toEqual([
      expect.objectContaining({
        severity: 'info',
        detail: 'Nothing was deployed for uat',
      }),
    ]);
  });

  it('strips ANSI escape codes from what it stores', async () => {
    const { repository, service } = setup();

    await service.ingestReport(
      body({
        stage: 'quality',
        conclusion: 'failure',
        results: {
          tests: {
            passed: 0,
            failed: 1,
            total: 1,
            failures: [{ name: 't', message: `${ESC}[31mboom${ESC}[39m` }],
          },
        },
      }),
    );

    const call = (repository.upsert as jest.Mock).mock.calls[0]![0] as {
      results: { tests: { failures: { message: string }[] } };
      friendlyMessages: { items?: { sub?: string }[] }[];
    };
    expect(call.results.tests.failures[0]!.message).toBe('boom');
    expect(call.friendlyMessages[0]!.items![0]!.sub).toBe('boom');
  });
});
