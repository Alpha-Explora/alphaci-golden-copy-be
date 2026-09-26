import {
  evaluateQaPromotionGate,
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
