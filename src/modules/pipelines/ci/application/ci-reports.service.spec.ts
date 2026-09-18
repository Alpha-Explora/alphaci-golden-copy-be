import { CiReportsService } from './ci-reports.service';
import type { CiReportBodyDto } from '../api/dto/ci-report-body.dto';
import type { DatabaseService } from '#kernel/db/database.service';
import { TenantContextRequiredError } from '#kernel/tenancy/tenant-context.js';
import type {
  TenantContext,
  TenantContextPort,
} from '#kernel/tenancy/tenant-context.port.js';
import type {
  CiRunReportRow,
  CiRunReportsRepository,
} from '../infrastructure/ci-run-reports.repository';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const makeDatabaseService = () =>
  ({
    query: jest.fn().mockResolvedValue({
      rows: [{ repo_full_name: 'acme/orders-api' }],
    }),
  }) as unknown as DatabaseService;

const makeTenantContext = (tenantId = TENANT_A): TenantContextPort => {
  const context: TenantContext = {
    tenantId,
    userId: USER_ID,
    membershipRole: 'member',
    deploymentMode: 'hosted',
  };
  return {
    current: () => context,
    require: () => context,
    set: jest.fn(),
    clear: jest.fn(),
  };
};

const makeRunReportsRepository = () =>
  ({
    upsertDeploymentGlobal: jest.fn(),
    findRecentByRepo: jest.fn(),
    findRecentByUser: jest.fn(),
  }) as unknown as CiRunReportsRepository;

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

describe('CiReportsService.getRuns grouping', () => {
  let databaseService: DatabaseService;
  let runReportsRepository: CiRunReportsRepository;
  let service: CiReportsService;

  beforeEach(() => {
    databaseService = makeDatabaseService();
    runReportsRepository = makeRunReportsRepository();
    service = new CiReportsService(
      databaseService,
      runReportsRepository,
      makeTenantContext(),
    );
  });

  it('merges access/quality/package rows sharing a commit SHA into one run, even though each stage has its own GitHub run_id', async () => {
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({ stage: 'package', run_id: '300', status: 'failure' }),
      row({ stage: 'quality', run_id: '200', status: 'success' }),
      row({ stage: 'access', run_id: '100', status: 'success' }),
    ]);

    const { runs } = await service.getRuns('user-1');

    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.commitSha).toBe('sha-1');
    // The pipeline is represented by its furthest-progressed stage's run_id.
    expect(run!.runId).toBe(300);
    expect(run!.overallStatus).toBe('failure');

    const byStage = new Map(run!.stages.map((s) => [s.stage, s]));
    expect(byStage.get('access')?.status).toBe('success');
    expect(byStage.get('quality')?.status).toBe('success');
    expect(byStage.get('package')?.status).toBe('failure');
    // No stage should be left as a permanent "pending" ghost when its real
    // report exists under a different run_id.
    expect(byStage.get('access')?.githubRunUrl).toContain('/runs/100');
    expect(byStage.get('quality')?.githubRunUrl).toContain('/runs/200');
    expect(byStage.get('package')?.githubRunUrl).toContain('/runs/300');
  });

  it('keeps a just-triggered stage pending while it could still be queueing', async () => {
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({
        stage: 'access',
        run_id: '400',
        commit_sha: 'sha-2',
        status: 'success',
        // Reported moments ago: quality may simply not have started yet.
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    ]);

    const { runs } = await service.getRuns('user-1');

    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.commitSha).toBe('sha-2');
    const byStage = new Map(run!.stages.map((s) => [s.stage, s]));
    expect(byStage.get('access')?.status).toBe('success');
    expect(byStage.get('quality')?.status).toBe('pending');
    expect(byStage.get('package')?.status).toBe('pending');
    expect(run!.overallStatus).toBe('partial');
  });

  it('calls a long-silent stage stalled rather than leaving it pending forever', async () => {
    // A workflow rejected at startup runs no jobs, so it never reports. The
    // run sat on "pending" indefinitely and the pipeline looked merely slow.
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({
        stage: 'access',
        run_id: '400',
        commit_sha: 'sha-2',
        status: 'success',
      }),
    ]);

    const { runs } = await service.getRuns('user-1');

    const byStage = new Map(runs[0]!.stages.map((s) => [s.stage, s]));
    expect(byStage.get('quality')?.status).toBe('stalled');
    expect(byStage.get('quality')?.friendlyMessages[0]?.severity).toBe('error');
    // Package is a consequence, not a second problem: naming both would report
    // one broken pipeline as two.
    expect(byStage.get('package')?.status).toBe('blocked');
    expect(runs[0]!.overallStatus).toBe('failure');
  });

  it('ignores a stale re-run row for a stage that already has a more recent report', async () => {
    // Rows arrive ordered run_id DESC (as the repository query guarantees).
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({ stage: 'access', run_id: '150', status: 'success' }),
      row({ stage: 'access', run_id: '100', status: 'failure' }),
    ]);

    const { runs } = await service.getRuns('user-1');

    const byStage = new Map(runs[0]!.stages.map((s) => [s.stage, s]));
    expect(byStage.get('access')?.status).toBe('success');
    expect(byStage.get('access')?.githubRunUrl).toContain('/runs/150');
  });
});

/*
 * The per-tool list has to survive the round trip.
 *
 * It is stored inside `results`, which is jsonb typed `Record<string, unknown>`,
 * and `results` was never returned to the client at all — so the data existed in
 * the database and one bar still stood in for seven tools. These cover the
 * reading half: what comes back out, and what is refused.
 */
describe('CiReportsService.getRuns per-tool checks', () => {
  let databaseService: DatabaseService;
  let runReportsRepository: CiRunReportsRepository;
  let service: CiReportsService;

  beforeEach(() => {
    databaseService = makeDatabaseService();
    runReportsRepository = makeRunReportsRepository();
    service = new CiReportsService(
      databaseService,
      runReportsRepository,
      makeTenantContext(),
    );
  });

  const stageOf = async (results: Record<string, unknown>) => {
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({ stage: 'quality', run_id: '200', status: 'success', results }),
    ]);

    const { runs } = await service.getRuns('user-1');
    return runs[0]!.stages.find((stage) => stage.stage === 'quality')!;
  };

  it('returns every tool the stage reported', async () => {
    const stage = await stageOf({
      checks: [
        { name: 'dotnet-tests', conclusion: 'success' },
        { name: 'lint', conclusion: 'success' },
        { name: 'sonar', conclusion: 'failure' },
      ],
    });

    expect(stage.checks.map((check) => check.name)).toEqual([
      'dotnet-tests',
      'lint',
      'sonar',
    ]);
    expect(stage.checks.find((c) => c.name === 'sonar')?.conclusion).toBe(
      'failure',
    );
  });

  /*
   * The distinction that matters: a stage can be green while a tool inside it
   * is not. That is the whole point of the list, and it is the normal state on
   * dev, where the gates are advisory.
   */
  it('reports a failed tool inside a stage that passed', async () => {
    const stage = await stageOf({
      checks: [
        { name: 'lint', conclusion: 'success' },
        { name: 'secrets', conclusion: 'failure' },
      ],
    });

    expect(stage.status).toBe('success');
    expect(stage.checks.find((c) => c.name === 'secrets')?.conclusion).toBe(
      'failure',
    );
  });

  it('carries the timings when the pipeline sent them, and omits them when it did not', async () => {
    const stage = await stageOf({
      checks: [
        {
          name: 'lint',
          conclusion: 'success',
          startedAt: '2026-09-11T00:00:00Z',
          completedAt: '2026-09-11T00:01:00Z',
        },
        { name: 'sbom', conclusion: 'success' },
      ],
    });

    expect(stage.checks[0]).toEqual({
      name: 'lint',
      conclusion: 'success',
      startedAt: '2026-09-11T00:00:00Z',
      completedAt: '2026-09-11T00:01:00Z',
    });
    // Absent rather than present-and-undefined, so the client can tell the
    // difference between "not sent" and "sent as null".
    expect(stage.checks[1]).toEqual({ name: 'sbom', conclusion: 'success' });
  });

  it('is empty for a pipeline generated before per-tool reporting', async () => {
    const stage = await stageOf({ coverage: { pct: 100, threshold: 80 } });

    expect(stage.checks).toEqual([]);
  });

  /*
   * `results` is jsonb: the shape is whatever was written, including by a
   * pipeline newer than this build. Malformed entries are dropped rather than
   * rendered, because a check with an undefined name reaches the UI as a blank
   * row that reads like a tool nobody can identify.
   */
  it('drops entries it cannot trust rather than rendering them', async () => {
    const stage = await stageOf({
      checks: [
        { name: 'lint', conclusion: 'success' },
        { name: 'missing-conclusion' },
        { conclusion: 'success' },
        'not-an-object',
        null,
        { name: 42, conclusion: 'success' },
      ],
    });

    expect(stage.checks).toEqual([{ name: 'lint', conclusion: 'success' }]);
  });

  it('survives checks arriving as something other than an array', async () => {
    expect((await stageOf({ checks: 'lint,sonar' })).checks).toEqual([]);
    expect((await stageOf({ checks: null })).checks).toEqual([]);
  });
});

/*
 * A promoted commit keeps its SHA, so the same commit runs a full pipeline on
 * dev, again on uat, and again on main. Those are three separate executions
 * with three separate results.
 *
 * Keyed on the SHA alone they collapsed into one group: the first branch seen
 * won, the stage guard discarded the others as duplicates of a stage already
 * filled, and two thirds of the work vanished from the product. Measured on a
 * real repository, commit d2d3dbe carried six reports across dev, uat and main
 * and rendered as one run on one branch.
 */
describe('CiReportsService.getRuns, one commit promoted across branches', () => {
  let service: CiReportsService;
  let runReportsRepository: CiRunReportsRepository;

  beforeEach(() => {
    runReportsRepository = makeRunReportsRepository();
    service = new CiReportsService(
      makeDatabaseService(),
      runReportsRepository,
      makeTenantContext(),
    );
  });

  it('keeps one run per branch instead of collapsing them', async () => {
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({
        branch: 'main',
        stage: 'quality',
        run_id: '600',
        status: 'success',
      }),
      row({
        branch: 'main',
        stage: 'access',
        run_id: '500',
        status: 'success',
      }),
      row({
        branch: 'uat',
        stage: 'quality',
        run_id: '400',
        status: 'failure',
      }),
      row({ branch: 'uat', stage: 'access', run_id: '300', status: 'success' }),
      row({
        branch: 'dev',
        stage: 'quality',
        run_id: '200',
        status: 'success',
      }),
      row({ branch: 'dev', stage: 'access', run_id: '100', status: 'success' }),
    ]);

    const { runs } = await service.getRuns('user-1');

    expect(runs).toHaveLength(3);
    expect(runs.map((run) => run.branch).sort()).toEqual([
      'dev',
      'main',
      'uat',
    ]);
    // Every one of them is the same commit; that is the point.
    expect(new Set(runs.map((run) => run.commitSha))).toEqual(
      new Set(['sha-1']),
    );
  });

  it('does not let one branch result mask another', async () => {
    // The uat run failed while dev and main passed. Collapsed into one group,
    // a reader saw a single status and could not tell which branch broke.
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({
        branch: 'main',
        stage: 'quality',
        run_id: '600',
        status: 'success',
      }),
      row({
        branch: 'uat',
        stage: 'quality',
        run_id: '400',
        status: 'failure',
      }),
      row({
        branch: 'dev',
        stage: 'quality',
        run_id: '200',
        status: 'success',
      }),
      row({ branch: 'main', stage: 'access', run_id: '550' }),
      row({ branch: 'uat', stage: 'access', run_id: '350' }),
      row({ branch: 'dev', stage: 'access', run_id: '150' }),
    ]);

    const { runs } = await service.getRuns('user-1');

    // Asserted per branch on the stage that actually reported. Overall status
    // also folds in stages that never reported, which is a separate rule; what
    // matters here is that uat's failure stays on uat.
    const qualityOf = (branch: string) =>
      runs
        .find((run) => run.branch === branch)
        ?.stages.find((stage) => stage.stage === 'quality')?.status;

    expect(qualityOf('uat')).toBe('failure');
    expect(qualityOf('dev')).toBe('success');
    expect(qualityOf('main')).toBe('success');
  });
});

describe('CiReportsService tenant scope', () => {
  it('keeps bearer-authenticated ingestion on the explicit deployment-global path', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ user_id: 'user-1', tenant_id: TENANT_A }],
    });
    const databaseService = { query } as unknown as DatabaseService;
    const runReportsRepository = makeRunReportsRepository();
    const service = new CiReportsService(databaseService, runReportsRepository);
    const body: CiReportBodyDto = {
      repoFullName: 'acme/orders-api',
      branch: 'main',
      commitSha: 'sha-1',
      runId: 42,
      stage: 'access',
      conclusion: 'success',
      results: {},
    };

    await expect(
      service.ingestDeploymentGlobalReport(body, 'project-1', TENANT_A),
    ).resolves.toEqual({ received: true });
    expect(runReportsRepository.upsertDeploymentGlobal).toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      body.repoFullName,
      'project-1',
      TENANT_A,
    ]);
  });

  it('pins bearer report ownership to the project returned by token validation', async () => {
    const query = jest.fn().mockResolvedValueOnce({
      rows: [{ user_id: 'user-1', tenant_id: TENANT_A }],
    });
    const databaseService = { query } as unknown as DatabaseService;
    const runReportsRepository = makeRunReportsRepository();
    const service = new CiReportsService(databaseService, runReportsRepository);
    const body: CiReportBodyDto = {
      repoFullName: 'acme/orders-api',
      branch: 'main',
      commitSha: 'sha-1',
      runId: 42,
      stage: 'access',
      conclusion: 'success',
      results: {},
    };

    await service.ingestDeploymentGlobalReport(body, 'project-1', TENANT_A);

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      body.repoFullName,
      'project-1',
      TENANT_A,
    ]);
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain('id = $2::uuid');
  });

  it('filters user-wide report rows through the selected tenant project set', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ repo_full_name: 'acme/orders-api' }] });
    const databaseService = { query } as unknown as DatabaseService;
    const runReportsRepository = makeRunReportsRepository();
    (runReportsRepository.findRecentByUser as jest.Mock).mockResolvedValueOnce([
      row({ repo_full_name: 'acme/orders-api', run_id: '200' }),
      row({ repo_full_name: 'other/secret-api', run_id: '100' }),
    ]);
    const service = new CiReportsService(
      databaseService,
      runReportsRepository,
      makeTenantContext(),
    );

    const { runs } = await service.getRuns('user-1');

    expect(runs).toHaveLength(1);
    expect(runs[0]?.repoFullName).toBe('acme/orders-api');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      TENANT_A,
    ]);
    expect(String(query.mock.calls[0]?.[0] ?? '')).toContain(
      'tenant_id = $2::uuid',
    );
  });

  it('rejects a repository owned by another tenant before reading its reports', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    const databaseService = { query } as unknown as DatabaseService;
    const runReportsRepository = makeRunReportsRepository();
    const service = new CiReportsService(
      databaseService,
      runReportsRepository,
      makeTenantContext(),
    );

    await expect(service.getRuns('user-1', 'other/secret-api')).rejects.toThrow(
      'You do not have access',
    );
    expect(runReportsRepository.findRecentByRepo).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'other/secret-api',
      'user-1',
      TENANT_A,
    ]);
  });

  it('fails closed when a user-facing report read has no tenant context', async () => {
    const databaseService = makeDatabaseService();
    const runReportsRepository = makeRunReportsRepository();
    const service = new CiReportsService(databaseService, runReportsRepository);

    await expect(service.getRuns('user-1')).rejects.toBeInstanceOf(
      TenantContextRequiredError,
    );
    expect(databaseService.query).not.toHaveBeenCalled();
    expect(runReportsRepository.findRecentByUser).not.toHaveBeenCalled();
  });
});
