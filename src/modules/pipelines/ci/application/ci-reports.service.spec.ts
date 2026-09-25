import { ForbiddenException } from '@nestjs/common';

import { CiReportsService } from './ci-reports.service';
import type { DatabaseService } from '#kernel/db/database.service';
import type { ProjectVisibilityLookup } from '#kernel/ports/project-visibility.port';
import type {
  CiRunReportRow,
  CiRunReportsRepository,
} from '../infrastructure/ci-run-reports.repository';

const makeDatabaseService = () =>
  ({
    query: jest.fn(),
  }) as unknown as DatabaseService;

const makeRunReportsRepository = () =>
  ({
    upsert: jest.fn(),
    findRecentByRepo: jest.fn(),
    findRecentByUser: jest.fn(),
  }) as unknown as CiRunReportsRepository;

/** Defaults to visible so tests that never exercise assertOwnership are unaffected. */
const makeProjectVisibility = (
  isRepoVisibleToUser: jest.Mock = jest.fn().mockResolvedValue(true),
): ProjectVisibilityLookup => ({ isRepoVisibleToUser });

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
      makeProjectVisibility(),
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
      makeProjectVisibility(),
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
      makeProjectVisibility(),
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

/**
 * assertOwnership used to be `pp.user_id = caller` only, so a workspace
 * member or QA tester who can see the project everywhere else in the
 * product got a 403 here. It now defers to PROJECT_VISIBILITY_LOOKUP (the
 * same role-aware rule projects.repository.ts's projectVisibilitySql
 * applies), reached through a port rather than a query in this file — see
 * project-visibility.port.ts's doc comment for why a plain cross-module
 * import would cycle.
 */
describe('CiReportsService.getRuns, repository-scoped visibility', () => {
  let runReportsRepository: CiRunReportsRepository;
  let projectVisibility: ProjectVisibilityLookup;
  let service: CiReportsService;

  beforeEach(() => {
    runReportsRepository = makeRunReportsRepository();
    projectVisibility = makeProjectVisibility();
    service = new CiReportsService(
      makeDatabaseService(),
      runReportsRepository,
      projectVisibility,
    );
  });

  it('returns the repo-scoped runs for a workspace member the visibility port says can see it', async () => {
    (runReportsRepository.findRecentByRepo as jest.Mock).mockResolvedValueOnce([
      row({ stage: 'access', run_id: '1', status: 'success' }),
    ]);

    const { runs } = await service.getRuns('member-1', 'acme/orders-api');

    expect(projectVisibility.isRepoVisibleToUser).toHaveBeenCalledWith(
      'acme/orders-api',
      'member-1',
    );
    expect(runs).toHaveLength(1);
  });

  it('403s when the visibility port says the caller cannot see the repo', async () => {
    (projectVisibility.isRepoVisibleToUser as jest.Mock).mockResolvedValueOnce(
      false,
    );

    await expect(
      service.getRuns('stranger-1', 'acme/orders-api'),
    ).rejects.toThrow(ForbiddenException);
    expect(
      runReportsRepository.findRecentByRepo as jest.Mock,
    ).not.toHaveBeenCalled();
  });
});
