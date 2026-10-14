import { fakeIterations } from '../../__fixtures__/project-iterations';
import type { QaChecklistsRepository } from '../../infrastructure/qa-checklists.repository';
import type {
  QaProjectRunHeadline,
  QaProjectRunsRepository,
  QaRunItemFact,
} from '../../infrastructure/qa-project-runs.repository';
import type { QaRequirementsRepository } from '../../infrastructure/qa-requirements.repository';
import type {
  QaProjectRunRow,
  QaRunItemRow,
  QaRunRepositoryRow,
  QaRunsRepository,
} from '../../infrastructure/qa-runs.repository';
import type { QaAccessService } from '../qa-checklists/qa-access.service';
import type {
  QaProjectContext,
  QaProjectContextService,
} from '../qa-checklists/qa-project-context.service';
import type { QaProgress } from '../qa-checklists/qa-requirements.contracts';
import { QaRequirementsService } from '../qa-checklists/qa-requirements.service';
import type { QaAutomationService } from './qa-automation.service';
import type { QaRunAttachmentsService } from './qa-run-attachments.service';
import { QaProjectRunsService } from './qa-project-runs.service';
import type { QaRunItemStatus, QaRunStatus } from './qa-runs.contracts';
import type { QaUatHeadsService } from './qa-uat-heads.service';

/**
 * The team overview's `counts.readyForQa` must equal the size of the
 * `readyForQa` bucket of GET /delivery-projects/:id/qa/my-items. Both services
 * are built here over ONE set of items and run items, so a change to either
 * side's reading of "ready for QA" fails this file.
 */

const DP = 'dp-1';
const SHA = 'a'.repeat(40);
const API = { projectId: 'p-api', name: 'api', repoFullName: 'acme/api' };

const project: QaProjectContext = {
  deliveryProjectId: DP,
  groupId: 'group-1',
  name: 'Checkout',
  repositories: [API],
};

/** [requirement item id, Progress, status of its run item or null for none]. */
const ITEMS: Array<[string, QaProgress, QaRunItemStatus | null]> = [
  ['a', 'done', null],
  ['b', 'done', 'pending'],
  ['c', 'done', 'passed'],
  ['d', 'done', 'failed'],
  ['e', 'done', 'blocked'],
  ['f', 'done', 'returned_to_dev'],
  ['g', 'in_progress', 'pending'],
  ['h', 'todo', null],
  ['i', 'in_progress', 'returned_to_dev'],
  ['j', 'done', 'pending'],
];
/** a, b and j: done and not yet decided by QA, with the run in force. */
const READY_WITH_RUN = 3;
/** Every done item, when no run is in force: a, b, c, d, e, f and j. */
const READY_WITHOUT_RUN = 7;

const runRow = (status: QaRunStatus): QaProjectRunRow => ({
  id: 'run-1',
  scope: 'project',
  project_id: null,
  commit_sha: null,
  delivery_project_id: DP,
  iteration_id: 'it-1',
  heads_fingerprint: 'f'.repeat(64),
  checklist_id: null,
  checklist_version: 0,
  checklist_name: 'Checkout',
  branch: 'uat',
  commit_source: 'branch_head',
  status,
  created_by: 'qa-1',
  created_by_login: 'qa',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

const runItemRow = (sourceItemId: string, status: QaRunItemStatus) =>
  ({
    id: `ri-${sourceItemId}`,
    run_id: 'run-1',
    source_item_id: sourceItemId,
    prior_run_item_id: null,
    position: 0,
    title: sourceItemId,
    description: null,
    target_persona: 'all',
    verification_type: 'manual',
    test_identifier: null,
    status,
    notes: null,
    defect_severity: null,
    reproduction_steps: null,
    fix_requested_at: null,
    fix_requested_by: null,
    fix_requested_by_login: null,
    fix_note: null,
    verified_by: null,
    verified_by_login: null,
    verified_at: null,
    row_version: 1,
    updated_at: '2026-10-01T00:00:00.000Z',
    requirement_id: 'req-1',
    requirement_name: 'Checkout',
    requirement_kind: 'functional',
    acceptance_criteria: null,
  }) as QaRunItemRow;

const coverage: QaRunRepositoryRow[] = [
  {
    run_id: 'run-1',
    project_id: 'p-api',
    repo_full_name: 'acme/api',
    head_sha: SHA,
  },
];

/**
 * @param run     the Project's newest run, or null for none
 * @param moved   a uat head has moved since that run (my-items reads the live heads)
 */
async function bothCounts(run: QaRunStatus | null, moved: boolean) {
  const rows = [{ id: 'req-1', name: 'Checkout', kind: 'functional' }];
  const requirementItems = new Map([
    [
      'req-1',
      ITEMS.map(([id, progress], position) => ({
        id,
        checklist_id: 'req-1',
        position,
        title: id,
        progress,
      })),
    ],
  ]);
  const runItems = run
    ? ITEMS.flatMap(([id, , status]) =>
        status ? [runItemRow(id, status)] : [],
      )
    : [];

  const checklists = {
    listItemsByChecklistIds: jest.fn().mockResolvedValue(requirementItems),
  } as unknown as jest.Mocked<QaChecklistsRepository>;

  // ---- GET /delivery-projects/:id/qa/my-items ----
  const runs = {
    listItemsByRunId: jest.fn().mockResolvedValue(runItems),
    findActiveSignoff: jest.fn().mockResolvedValue(null),
    findPriorItemSummaries: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaRunsRepository>;
  const feedProjectRuns = {
    // The heads still match the newest run only when nothing moved.
    findRunByFingerprint: jest
      .fn()
      .mockResolvedValue(run && !moved ? runRow(run) : null),
    findNewestProjectRun: jest
      .fn()
      .mockResolvedValue(run === 'open' ? runRow('open') : null),
    listCoverageByRunIds: jest
      .fn()
      .mockResolvedValue(new Map([['run-1', coverage]])),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const feedRequirements = {
    listActiveByIteration: jest.fn().mockResolvedValue(rows),
    listItemsByIds: jest.fn().mockResolvedValue(new Map()),
    requirementsChangedSince: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<QaRequirementsRepository>;
  const access = {
    findAppRole: jest.fn().mockResolvedValue('qa'),
    canAccessWorkspace: jest.fn().mockResolvedValue(true),
    canManage: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<QaAccessService>;
  const projectContext = {
    requireProject: jest.fn().mockResolvedValue(project),
    listGroupProjects: jest
      .fn()
      .mockResolvedValue([{ id: DP, name: 'Checkout' }]),
    listOverviewFacts: jest.fn().mockResolvedValue(new Map()),
  } as unknown as jest.Mocked<QaProjectContextService>;
  const heads = {
    readHeads: jest.fn().mockResolvedValue([
      {
        kind: 'ok',
        repository: API,
        sha: moved ? 'c'.repeat(40) : SHA,
      },
    ]),
  } as unknown as jest.Mocked<QaUatHeadsService>;
  const automation = {
    forRun: jest.fn().mockResolvedValue({ verify: null, quality: null }),
  } as unknown as jest.Mocked<QaAutomationService>;

  const { service: iterations } = fakeIterations();
  const feedService = new QaProjectRunsService(
    runs,
    feedProjectRuns,
    checklists,
    feedRequirements,
    {
      toItem: (item: { id: string; progress: QaProgress }) => ({
        id: item.id,
        progress: item.progress,
      }),
    } as unknown as QaRequirementsService,
    access,
    projectContext,
    heads,
    automation,
    {
      countsByItem: jest.fn().mockResolvedValue(new Map<string, number>()),
      referencesForRun: jest.fn().mockResolvedValue(new Map()),
      isEnabled: jest.fn().mockReturnValue(true),
    } as unknown as QaRunAttachmentsService,
    iterations,
  );
  const feed = await feedService.myItems(DP, {
    userId: 'qa-1',
    userLogin: 'qa',
    oauthToken: 'tok',
  });

  // ---- GET /workspaces/:id/qa-requirements/overview ----
  const headline: QaProjectRunHeadline | null = run
    ? {
        deliveryProjectId: DP,
        runId: 'run-1',
        status: run,
        createdAt: '2026-10-01T00:00:00.000000Z',
        verdict: run === 'signed_off' ? 'APPROVED' : null,
        signedAt: run === 'signed_off' ? '2026-10-02T00:00:00.000000Z' : null,
        signedByLogin: run === 'signed_off' ? 'qa-lead' : null,
      }
    : null;
  const facts: QaRunItemFact[] = runItems.map((row) => ({
    runId: row.run_id,
    sourceItemId: row.source_item_id,
    requirementId: row.requirement_id,
    status: row.status,
    defectSeverity: row.defect_severity,
  }));
  const overviewProjectRuns = {
    findLatestRunHeadlines: jest
      .fn()
      .mockResolvedValue(headline ? new Map([[DP, headline]]) : new Map()),
    listItemFactsByRunIds: jest
      .fn()
      .mockResolvedValue(run ? new Map([['run-1', facts]]) : new Map()),
  } as unknown as jest.Mocked<QaProjectRunsRepository>;
  const overviewService = new QaRequirementsService(
    checklists,
    {
      listByWorkspace: jest.fn().mockResolvedValue([
        {
          id: 'req-1',
          workspace_id: 'group-1',
          name: 'Checkout',
          kind: 'functional',
          delivery_project_id: DP,
          archived_at: null,
        },
      ]),
    } as unknown as QaRequirementsRepository,
    overviewProjectRuns,
    {} as unknown as QaRunsRepository,
    access,
    projectContext,
    iterations,
  );
  const overview = await overviewService.overview('group-1', 'qa-1', false);

  return {
    feed: feed.readyForQa.map((entry) => entry.item.id).sort(),
    overview: overview.groups[0]?.counts.readyForQa,
  };
}

describe('overview counts.readyForQa vs my-items readyForQa', () => {
  it('agree with no run at all: every done item is ready', async () => {
    const { feed, overview } = await bothCounts(null, false);

    expect(feed).toHaveLength(READY_WITHOUT_RUN);
    expect(overview).toBe(feed.length);
  });

  it('agree while the newest run is open and the heads have not moved', async () => {
    const { feed, overview } = await bothCounts('open', false);

    expect(feed).toEqual(['a', 'b', 'j']);
    expect(overview).toBe(READY_WITH_RUN);
  });

  it('agree while the newest run is open even after a head moved (my-items falls back to the newest open run)', async () => {
    const { feed, overview } = await bothCounts('open', true);

    expect(feed).toEqual(['a', 'b', 'j']);
    expect(overview).toBe(feed.length);
  });

  it('agree for a signed-off run the heads still match', async () => {
    const { feed, overview } = await bothCounts('signed_off', false);

    expect(feed).toEqual(['a', 'b', 'j']);
    expect(overview).toBe(feed.length);
  });

  /*
   * The one documented gap. The overview cannot read the live uat heads (no
   * GitHub call per Project), so it reads the newest run. After a head moves
   * past a SIGNED-OFF run, my-items has no run in force and lists every done
   * item, while the overview still counts only what that run left undecided.
   * If this starts failing because the two now agree, update the note on
   * QaRequirementsService.overview and the contract.
   */
  it('differ only for a signed-off run after a head moved', async () => {
    const { feed, overview } = await bothCounts('signed_off', true);

    expect(feed).toHaveLength(READY_WITHOUT_RUN);
    expect(overview).toBe(READY_WITH_RUN);
  });
});
