import {
  evaluateProjectPromotionGate,
  evaluateQaPromotionGate,
  type QaProjectGateInput,
  type QaProjectGateRun,
  type QaPromotionChecklistCandidate,
} from './qa-promotion.rules';

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const SHORT_SHA = 'a1b2c3d';

const checklist = (
  overrides: Partial<QaPromotionChecklistCandidate> = {},
): QaPromotionChecklistCandidate => ({
  id: 'checklist-1',
  name: 'Release checklist',
  run: null,
  ...overrides,
});

describe('evaluateQaPromotionGate', () => {
  it('no checklists shared: not eligible, one reason, empty checklists array', () => {
    const result = evaluateQaPromotionGate({ headSha: SHA, checklists: [] });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      'No QA checklist is shared to this project',
    ]);
    expect(result.checklists).toEqual([]);
  });

  it('head unreadable: not eligible, one reason, no per-checklist reasons even with checklists present', () => {
    const result = evaluateQaPromotionGate({
      headSha: null,
      checklists: [checklist()],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['Could not read the uat branch head']);
    expect(result.checklists).toEqual([
      {
        id: 'checklist-1',
        name: 'Release checklist',
        runId: null,
        verdict: null,
        runStatus: null,
        approvedForHead: false,
      },
    ]);
  });

  it('head unreadable AND no checklists: both reasons present', () => {
    const result = evaluateQaPromotionGate({ headSha: null, checklists: [] });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      'Could not read the uat branch head',
      'No QA checklist is shared to this project',
    ]);
  });

  it('missing run (also covers "approved on an OLD sha" -- the caller only ever looks up by the current headSha, so an old-sha run is indistinguishable from no run)', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [checklist({ run: null })],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      `"Release checklist": no QA run on uat @ ${SHORT_SHA}`,
    ]);
    expect(result.checklists[0]).toEqual({
      id: 'checklist-1',
      name: 'Release checklist',
      runId: null,
      verdict: null,
      runStatus: null,
      approvedForHead: false,
    });
  });

  it('open run (not yet signed off): not approved, reason names the checklist', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [
        checklist({
          run: { id: 'run-1', status: 'open', activeVerdict: null },
        }),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      '"Release checklist": run not signed off yet',
    ]);
    expect(result.checklists[0]).toEqual({
      id: 'checklist-1',
      name: 'Release checklist',
      runId: 'run-1',
      verdict: null,
      runStatus: 'open',
      approvedForHead: false,
    });
  });

  it('signed off Rejected: not approved', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [
        checklist({
          run: { id: 'run-1', status: 'signed_off', activeVerdict: 'REJECTED' },
        }),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      '"Release checklist": signed off Rejected',
    ]);
    expect(result.checklists[0]).toEqual({
      id: 'checklist-1',
      name: 'Release checklist',
      runId: 'run-1',
      verdict: 'REJECTED',
      runStatus: 'signed_off',
      approvedForHead: false,
    });
  });

  it('signed off Conditional: not approved (only Approved counts)', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [
        checklist({
          run: {
            id: 'run-1',
            status: 'signed_off',
            activeVerdict: 'CONDITIONAL',
          },
        }),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      '"Release checklist": signed off Conditional (only Approved counts)',
    ]);
    expect(result.checklists[0]).toEqual({
      id: 'checklist-1',
      name: 'Release checklist',
      runId: 'run-1',
      verdict: 'CONDITIONAL',
      runStatus: 'signed_off',
      approvedForHead: false,
    });
  });

  it('signed off with no recorded active verdict (defensive: data inconsistency): not approved', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [
        checklist({
          run: { id: 'run-1', status: 'signed_off', activeVerdict: null },
        }),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      '"Release checklist": signed off with no recorded verdict',
    ]);
  });

  it('all approved: eligible, no reasons', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [
        checklist({
          id: 'checklist-1',
          name: 'Release checklist',
          run: { id: 'run-1', status: 'signed_off', activeVerdict: 'APPROVED' },
        }),
        checklist({
          id: 'checklist-2',
          name: 'Smoke checklist',
          run: { id: 'run-2', status: 'signed_off', activeVerdict: 'APPROVED' },
        }),
      ],
    });

    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.checklists).toEqual([
      {
        id: 'checklist-1',
        name: 'Release checklist',
        runId: 'run-1',
        verdict: 'APPROVED',
        runStatus: 'signed_off',
        approvedForHead: true,
      },
      {
        id: 'checklist-2',
        name: 'Smoke checklist',
        runId: 'run-2',
        verdict: 'APPROVED',
        runStatus: 'signed_off',
        approvedForHead: true,
      },
    ]);
  });

  it('one approved, one not: not eligible, only the failing checklist contributes a reason', () => {
    const result = evaluateQaPromotionGate({
      headSha: SHA,
      checklists: [
        checklist({
          id: 'checklist-1',
          name: 'Release checklist',
          run: { id: 'run-1', status: 'signed_off', activeVerdict: 'APPROVED' },
        }),
        checklist({
          id: 'checklist-2',
          name: 'Smoke checklist',
          run: null,
        }),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      `"Smoke checklist": no QA run on uat @ ${SHORT_SHA}`,
    ]);
  });
});

describe('evaluateProjectPromotionGate', () => {
  const API = { projectId: 'p-api', repoFullName: 'acme/api' };
  const WEB = { projectId: 'p-web', repoFullName: 'acme/web' };
  const SHA_API = 'a'.repeat(40);
  const SHA_WEB = 'b'.repeat(40);
  const MOVED = 'c'.repeat(40);

  const run = (
    overrides: Partial<QaProjectGateRun> = {},
  ): QaProjectGateRun => ({
    id: 'run-1',
    verdict: 'APPROVED',
    signedAt: '2026-10-01T00:00:00Z',
    coverage: [
      { projectId: 'p-api', headSha: SHA_API },
      { projectId: 'p-web', headSha: SHA_WEB },
    ],
    ...overrides,
  });

  const input = (
    overrides: Partial<QaProjectGateInput> = {},
  ): QaProjectGateInput => ({
    repositories: [
      { ...API, currentSha: SHA_API },
      { ...WEB, currentSha: SHA_WEB },
    ],
    requirementCount: 3,
    latestSignedOffRun: run(),
    itemsNotPassed: 0,
    requirementsChangedAfterSignoff: false,
    ...overrides,
  });

  it('blocks an Approved run that did not pass every item the Iteration holds now', () => {
    const one = evaluateProjectPromotionGate(input({ itemsNotPassed: 1 }));
    expect(one.eligible).toBe(false);
    expect(one.reasons).toEqual([
      '1 requirement item is not passed in the signed-off QA run: a Product owner reopens the run so QA verifies them',
    ]);

    const two = evaluateProjectPromotionGate(input({ itemsNotPassed: 2 }));
    expect(two.reasons).toEqual([
      '2 requirement items are not passed in the signed-off QA run: a Product owner reopens the run so QA verifies them',
    ]);
  });

  it('blocks when requirements changed after the sign-off', () => {
    const result = evaluateProjectPromotionGate(
      input({ requirementsChangedAfterSignoff: true }),
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([
      'Requirements changed after QA signed off: a Product owner reopens the run so QA verifies them',
    ]);
    expect(result.run?.stale).toBe(false);
  });

  it('is eligible when the latest signed-off run is Approved and current for every repository', () => {
    const result = evaluateProjectPromotionGate(input());

    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.run).toEqual({
      id: 'run-1',
      verdict: 'APPROVED',
      signedAt: '2026-10-01T00:00:00Z',
      stale: false,
    });
    expect(result.repositories.map((repo) => repo.moved)).toEqual([
      false,
      false,
    ]);
  });

  it('blocks when no signed-off run exists (an open run never counts)', () => {
    const result = evaluateProjectPromotionGate(
      input({ latestSignedOffRun: null }),
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['No QA run covers the current uat heads']);
    expect(result.run).toBeNull();
    expect(result.repositories.every((repo) => repo.runSha === null)).toBe(
      true,
    );
  });

  it.each([
    ['REJECTED', 'Latest sign-off is Rejected'],
    ['CONDITIONAL', 'Latest sign-off is Conditional (only Approved counts)'],
  ] as const)('blocks a %s verdict', (verdict, reason) => {
    const result = evaluateProjectPromotionGate(
      input({ latestSignedOffRun: run({ verdict }) }),
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual([reason]);
    expect(result.run?.verdict).toBe(verdict);
  });

  it('blocks every repository when one repository moved, and names it', () => {
    const result = evaluateProjectPromotionGate(
      input({
        repositories: [
          { ...API, currentSha: SHA_API },
          { ...WEB, currentSha: MOVED },
        ],
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.run?.stale).toBe(true);
    expect(result.reasons).toEqual([
      'Project run is stale: "web" moved from bbbbbbb to ccccccc',
    ]);
    expect(result.repositories).toEqual([
      { ...API, runSha: SHA_API, currentSha: SHA_API, moved: false },
      { ...WEB, runSha: SHA_WEB, currentSha: MOVED, moved: true },
    ]);
  });

  it('is stale when a repository joined the Project after the run', () => {
    const result = evaluateProjectPromotionGate(
      input({
        latestSignedOffRun: run({
          coverage: [{ projectId: 'p-api', headSha: SHA_API }],
        }),
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.run?.stale).toBe(true);
    expect(result.reasons).toEqual([
      'Project run is stale: "web" was added to the Project after the run',
    ]);
  });

  it('blocks when a head could not be read, without calling the run stale', () => {
    const result = evaluateProjectPromotionGate(
      input({
        repositories: [
          { ...API, currentSha: SHA_API },
          { ...WEB, currentSha: null },
        ],
      }),
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['Could not read the uat head of "web"']);
    expect(result.run?.stale).toBe(false);
  });

  it('blocks a Project with no requirements even when a run is Approved', () => {
    const result = evaluateProjectPromotionGate(input({ requirementCount: 0 }));

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['This Project has no QA requirements']);
  });

  it('degenerates to the old rule for a single-repository Project', () => {
    const single = {
      repositories: [{ ...API, currentSha: SHA_API }],
      latestSignedOffRun: run({
        coverage: [{ projectId: 'p-api', headSha: SHA_API }],
      }),
    };

    expect(evaluateProjectPromotionGate(input(single)).eligible).toBe(true);
    expect(
      evaluateProjectPromotionGate(
        input({
          ...single,
          repositories: [{ ...API, currentSha: MOVED }],
        }),
      ).eligible,
    ).toBe(false);
  });

  it('judges the NEWEST signed-off run: a Rejected sign-off on newer heads blocks an older Approved one', () => {
    // The repository supplies the latest signed-off run; the older Approved run
    // is simply not the input. Rejected on current heads must block.
    const result = evaluateProjectPromotionGate(
      input({ latestSignedOffRun: run({ id: 'run-2', verdict: 'REJECTED' }) }),
    );

    expect(result.eligible).toBe(false);
    expect(result.run?.id).toBe('run-2');
  });

  it('reports a defensive missing verdict as a blocking reason', () => {
    const result = evaluateProjectPromotionGate(
      input({ latestSignedOffRun: run({ verdict: null }) }),
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['Latest sign-off has no recorded verdict']);
    expect(result.run).toBeNull();
  });
});
