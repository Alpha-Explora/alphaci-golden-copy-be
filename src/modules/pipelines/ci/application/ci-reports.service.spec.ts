import { CiReportsService } from './ci-reports.service';
import type { DatabaseService } from '#kernel/db/database.service';
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
    service = new CiReportsService(databaseService, runReportsRepository);
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
