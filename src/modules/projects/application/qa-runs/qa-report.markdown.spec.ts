import type { QaRun, QaRunItem } from './qa-runs.contracts';
import type {
  QaReport,
  QaReportDefect,
  QaReportSignoffHistoryEntry,
} from './qa-report.contracts';
import { QA_REPORT_SCHEMA_VERSION } from './qa-report.contracts';
import { renderQaReportMarkdown } from './qa-report.markdown';

const item = (overrides: Partial<QaRunItem> = {}): QaRunItem => ({
  id: 'item-1',
  runId: 'run-1',
  position: 0,
  title: 'Smoke test login',
  description: null,
  targetPersona: 'all',
  verificationType: 'manual',
  testIdentifier: null,
  status: 'pending',
  notes: null,
  defectSeverity: null,
  reproductionSteps: null,
  fixRequest: null,
  verifiedBy: null,
  verifiedAt: null,
  rowVersion: 1,
  canUpdate: true,
  previous: null,
  automated: null,
  ...overrides,
});

const run = (overrides: Partial<QaRun> = {}): QaRun => ({
  id: 'run-1',
  scope: 'repository' as const,
  legacy: true as const,
  projectId: 'project-1',
  checklistId: 'checklist-1',
  checklistName: 'Release checklist',
  checklistVersion: 3,
  branch: 'main',
  commitSha: 'abcdef01234567890123456789012345678901',
  commitSource: 'deployment',
  status: 'open',
  createdBy: { id: 'creator-1', login: 'creator' },
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
  summary: {
    total: 1,
    byStatus: {
      pending: 1,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      returned_to_dev: 0,
    },
    openDefects: 0,
    blockers: 0,
  },
  signoff: null,
  items: [item()],
  permissions: {
    canUpdateItems: true,
    canReturnToDev: true,
    canRequestRetest: true,
    canSignOff: true,
    canReopen: false,
  },
  automation: { verify: null, quality: null },
  ...overrides,
});

const defect = (overrides: Partial<QaReportDefect> = {}): QaReportDefect => ({
  position: 0,
  title: 'Login button unresponsive',
  status: 'failed',
  severity: 'major',
  notes: null,
  reproductionSteps: null,
  targetPersona: 'all',
  fixRequest: null,
  ...overrides,
});

const report = (overrides: Partial<QaReport> = {}): QaReport => ({
  schemaVersion: QA_REPORT_SCHEMA_VERSION,
  generatedAt: '2026-09-25T04:00:00.000Z',
  frozen: false,
  project: {
    id: 'project-1',
    repoFullName: 'Alpha-Explora/alphaci-golden-copy-be',
    name: 'alphaci-golden-copy-be',
  },
  run: run(),
  summary: {
    totalItems: 1,
    passed: 0,
    failed: 0,
    blocked: 0,
    returnedToDev: 0,
    pending: 1,
    inProgress: 0,
    completionRate: 0,
    openDefects: 0,
    blockers: 0,
    verdict: null,
  },
  defects: [],
  automatedResults: null,
  signoffHistory: [],
  ...overrides,
});

describe('renderQaReportMarkdown / header', () => {
  it('titles the report with the repo full name and lists an open run as such', () => {
    const md = renderQaReportMarkdown(report());
    expect(md).toContain('# QA report — Alpha-Explora/alphaci-golden-copy-be');
    expect(md).toContain('| Run status | Open |');
    expect(md).toContain('| Verdict | Not signed off |');
    expect(md).toContain('| Signed off by | — |');
  });

  it('shows only the 7-char short sha, never the full commit', () => {
    const md = renderQaReportMarkdown(report());
    expect(md).toContain('| Commit | abcdef0 |');
    expect(md).not.toContain(run().commitSha);
  });

  it('labels commit source and checklist name+version', () => {
    const md = renderQaReportMarkdown(
      report({ run: run({ commitSource: 'branch_head' }) }),
    );
    expect(md).toContain('| Commit source | Branch head |');
    expect(md).toContain('| Checklist | Release checklist v3 |');
  });

  it('shows verdict, signed-off-by, and Signed off run status for a signed-off run', () => {
    const signedOffRun = run({
      status: 'signed_off',
      signoff: {
        id: 'signoff-1',
        verdict: 'APPROVED',
        summary: null,
        conditions: null,
        signedBy: { id: 'qa-1', login: 'qa-alice' },
        signedAt: '2026-09-25T05:00:00.000Z',
      },
    });
    const md = renderQaReportMarkdown(report({ run: signedOffRun }));
    expect(md).toContain('| Run status | Signed off |');
    expect(md).toContain('| Verdict | APPROVED |');
    expect(md).toContain(
      '| Signed off by | @qa-alice, 2026-09-25 05:00:00 UTC |',
    );
  });

  it('formats generatedAt as a UTC date-time', () => {
    const md = renderQaReportMarkdown(report());
    expect(md).toContain('| Generated | 2026-09-25 04:00:00 UTC |');
  });

  it('escapes a pipe and collapses a newline in a free-text metadata cell', () => {
    const md = renderQaReportMarkdown(
      report({ run: run({ branch: 'feat/weird|branch\nname' }) }),
    );
    expect(md).toContain('| Branch | feat/weird\\|branch<br>name |');
  });
});

describe('renderQaReportMarkdown / executive summary', () => {
  it('reports completion as N / M passed (floored integer percent)', () => {
    const summary = {
      totalItems: 3,
      passed: 2,
      failed: 1,
      blocked: 0,
      returnedToDev: 0,
      pending: 0,
      inProgress: 0,
      completionRate: 0.6667,
      openDefects: 1,
      blockers: 1,
    } as const;
    const md = renderQaReportMarkdown(
      report({ summary: { ...summary, verdict: null } }),
    );
    expect(md).toContain('- Completion: 2 / 3 passed (66%)');
    expect(md).toContain('- Open defects: 1');
    expect(md).toContain('- Blockers: 1');
  });

  it('never divides by zero: 0/0 renders as 0%', () => {
    const md = renderQaReportMarkdown(report());
    expect(md).toContain('- Completion: 0 / 1 passed (0%)');
  });
});

describe('renderQaReportMarkdown / checklist', () => {
  it('numbers items 1-based and maps persona/verification/status to labels', () => {
    const items = [
      item({
        position: 0,
        title: 'Dev-only check',
        targetPersona: 'developer',
        verificationType: 'playwright',
        status: 'in_progress',
      }),
      item({
        position: 1,
        title: 'QA-only check',
        targetPersona: 'qa',
        verificationType: 'unit_test',
        status: 'blocked',
        defectSeverity: 'minor',
      }),
      item({
        position: 2,
        title: 'Bruno check',
        targetPersona: 'all',
        verificationType: 'bruno',
        status: 'returned_to_dev',
        defectSeverity: 'minor',
      }),
    ];
    const md = renderQaReportMarkdown(report({ run: run({ items }) }));

    expect(md).toContain(
      '| 1 | Dev-only check | Developer | Playwright E2E | In progress | — |',
    );
    expect(md).toContain(
      '| 2 | QA-only check | QA Team | Unit test | Blocked | — |',
    );
    expect(md).toContain(
      '| 3 | Bruno check | Everyone | Bruno API | Returned to dev | — |',
    );
  });

  it('renders the checklist table sorted by position regardless of input order', () => {
    const items = [
      item({ position: 2, title: 'third' }),
      item({ position: 0, title: 'first' }),
      item({ position: 1, title: 'second' }),
    ];
    const md = renderQaReportMarkdown(report({ run: run({ items }) }));
    const firstIdx = md.indexOf('| 1 | first');
    const secondIdx = md.indexOf('| 2 | second');
    const thirdIdx = md.indexOf('| 3 | third');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it('escapes a pipe and collapses newlines in Notes, and trims it', () => {
    const items = [item({ notes: '  line one\nline two | with pipe  ' })];
    const md = renderQaReportMarkdown(report({ run: run({ items }) }));
    expect(md).toContain('line one<br>line two \\| with pipe');
  });

  it('renders an em dash for empty or null Notes', () => {
    const withNull = renderQaReportMarkdown(
      report({ run: run({ items: [item({ notes: null })] }) }),
    );
    const withBlank = renderQaReportMarkdown(
      report({ run: run({ items: [item({ notes: '   ' })] }) }),
    );
    expect(withNull).toMatch(/\| Pending \| — \|/);
    expect(withBlank).toMatch(/\| Pending \| — \|/);
  });
});

describe('renderQaReportMarkdown / checklist — automated suffix', () => {
  it('appends "(auto: <status>)" to the Status cell when the item has an automated result', () => {
    const items = [
      item({
        position: 0,
        status: 'passed',
        verificationType: 'playwright',
        automated: {
          source: 'playwright',
          stage: 'verify',
          status: 'passed',
          scope: 'spec',
          matchedSpec: 'e2e/checkout.spec.ts',
          failure: null,
          runId: 1,
          runUrl: 'https://github.com/org/repo/actions/runs/1',
          reportedAt: '2026-09-25T00:00:00.000Z',
        },
      }),
    ];
    const md = renderQaReportMarkdown(report({ run: run({ items }) }));
    expect(md).toContain(
      '| 1 | Smoke test login | Everyone | Playwright E2E | Passed (auto: passed) | — |',
    );
  });

  it('leaves the Status cell unchanged for a manual item (automated is null)', () => {
    const items = [item({ status: 'pending', automated: null })];
    const md = renderQaReportMarkdown(report({ run: run({ items }) }));
    expect(md).toContain(
      '| 1 | Smoke test login | Everyone | Manual check | Pending | — |',
    );
  });

  it('renders "not run" (with a space, not the raw not_run) for that automated status', () => {
    const items = [
      item({
        status: 'pending',
        verificationType: 'bruno',
        automated: {
          source: 'bruno',
          stage: 'verify',
          status: 'not_run',
          scope: 'stage',
          matchedSpec: null,
          failure: null,
          runId: null,
          runUrl: null,
          reportedAt: null,
        },
      }),
    ];
    const md = renderQaReportMarkdown(report({ run: run({ items }) }));
    expect(md).toContain('Pending (auto: not run)');
  });
});

describe('renderQaReportMarkdown / automated results', () => {
  it('says "Not available yet." when automatedResults is null', () => {
    const md = renderQaReportMarkdown(report({ automatedResults: null }));
    expect(md).toContain('## Automated results\n\nNot available yet.');
  });

  it('says "Not available yet." when automatedResults has both stages null', () => {
    const md = renderQaReportMarkdown(
      report({ automatedResults: { verify: null, quality: null } }),
    );
    expect(md).toContain('## Automated results\n\nNot available yet.');
  });

  it('renders a Stage | Status | Tests | Run row per present stage', () => {
    const md = renderQaReportMarkdown(
      report({
        automatedResults: {
          verify: {
            stage: 'verify',
            status: 'success',
            runId: 42,
            runUrl: 'https://github.com/org/repo/actions/runs/42',
            reportedAt: '2026-09-25T02:00:00.000Z',
            tests: {
              total: 5,
              passed: 5,
              failed: 0,
              failures: [],
              failuresTruncated: false,
            },
          },
          quality: {
            stage: 'quality',
            status: 'failure',
            runId: 43,
            runUrl: 'https://github.com/org/repo/actions/runs/43',
            reportedAt: '2026-09-25T02:05:00.000Z',
            tests: null,
          },
        },
      }),
    );

    expect(md).toContain(
      '| Verify | Success | 5/5 | [#42](https://github.com/org/repo/actions/runs/42) |',
    );
    expect(md).toContain(
      '| Quality | Failure | — | [#43](https://github.com/org/repo/actions/runs/43) |',
    );
  });

  it('lists failures as "name — message", prefixed by which stage', () => {
    const md = renderQaReportMarkdown(
      report({
        automatedResults: {
          verify: {
            stage: 'verify',
            status: 'failure',
            runId: 42,
            runUrl: 'https://github.com/org/repo/actions/runs/42',
            reportedAt: '2026-09-25T02:00:00.000Z',
            tests: {
              total: 2,
              passed: 1,
              failed: 1,
              failures: [
                {
                  name: 'e2e/checkout.spec.ts > Checkout > pays',
                  message: 'Timed out waiting for selector',
                },
              ],
              failuresTruncated: false,
            },
          },
          quality: null,
        },
      }),
    );

    expect(md).toContain(
      '- **Verify:** e2e/checkout.spec.ts > Checkout > pays — Timed out waiting for selector',
    );
  });

  it('says "None." under Failures when no stage reports any', () => {
    const md = renderQaReportMarkdown(
      report({
        automatedResults: {
          verify: {
            stage: 'verify',
            status: 'success',
            runId: 1,
            runUrl: 'https://github.com/org/repo/actions/runs/1',
            reportedAt: '2026-09-25T00:00:00.000Z',
            tests: {
              total: 1,
              passed: 1,
              failed: 0,
              failures: [],
              failuresTruncated: false,
            },
          },
          quality: null,
        },
      }),
    );
    expect(md).toContain('### Failures\n\nNone.');
  });

  it('adds a truncation note naming the stage when failuresTruncated is true', () => {
    const md = renderQaReportMarkdown(
      report({
        automatedResults: {
          verify: {
            stage: 'verify',
            status: 'failure',
            runId: 1,
            runUrl: 'https://github.com/org/repo/actions/runs/1',
            reportedAt: '2026-09-25T00:00:00.000Z',
            tests: {
              total: 30,
              passed: 5,
              failed: 25,
              failures: [{ name: 'e2e/a.spec.ts > x', message: 'boom' }],
              failuresTruncated: true,
            },
          },
          quality: null,
        },
      }),
    );
    expect(md).toContain('Only the first 20 failures are shown for: Verify.');
  });

  it('omits the truncation note when nothing is truncated', () => {
    const md = renderQaReportMarkdown(
      report({
        automatedResults: {
          verify: {
            stage: 'verify',
            status: 'failure',
            runId: 1,
            runUrl: 'https://github.com/org/repo/actions/runs/1',
            reportedAt: '2026-09-25T00:00:00.000Z',
            tests: {
              total: 1,
              passed: 0,
              failed: 1,
              failures: [{ name: 'e2e/a.spec.ts > x', message: 'boom' }],
              failuresTruncated: false,
            },
          },
          quality: null,
        },
      }),
    );
    expect(md).not.toContain('Only the first 20 failures');
  });
});

describe('renderQaReportMarkdown / defects', () => {
  it('says "No open defects." when there are none', () => {
    const md = renderQaReportMarkdown(report({ defects: [] }));
    expect(md).toContain('## Defects\n\nNo open defects.');
  });

  it('labels severity, falling back to Unrated for null', () => {
    const md = renderQaReportMarkdown(
      report({
        defects: [
          defect({ severity: 'blocker', title: 'A' }),
          defect({ severity: null, title: 'B' }),
        ],
      }),
    );
    expect(md).toContain('### Blocker — A');
    expect(md).toContain('### Unrated — B');
  });

  it('collapses a newline out of the defect title heading', () => {
    const md = renderQaReportMarkdown(
      report({ defects: [defect({ title: 'Broken\non two lines' })] }),
    );
    expect(md).toContain('### Major — Broken on two lines');
    expect(md).not.toMatch(/### Major — Broken\non/);
  });

  it('renders an em dash for null notes and reproduction steps', () => {
    const md = renderQaReportMarkdown(
      report({ defects: [defect({ notes: null, reproductionSteps: null })] }),
    );
    expect(md).toContain('**Notes:** —');
    expect(md).toContain('**Reproduction steps:**\n\n—');
  });

  it('renders reproduction steps as a fenced block, preserving line breaks', () => {
    const md = renderQaReportMarkdown(
      report({
        defects: [
          defect({ reproductionSteps: '1. Open the app\n2. Click login' }),
        ],
      }),
    );
    expect(md).toContain('```\n1. Open the app\n2. Click login\n```');
  });

  it('widens the fence when the content itself contains a triple backtick', () => {
    const md = renderQaReportMarkdown(
      report({
        defects: [
          defect({ reproductionSteps: 'run ```echo hi``` in the console' }),
        ],
      }),
    );
    expect(md).toContain('````\nrun ```echo hi``` in the console\n````');
  });

  it('omits the fix request line entirely when there is none', () => {
    const md = renderQaReportMarkdown(
      report({ defects: [defect({ fixRequest: null })] }),
    );
    expect(md).not.toContain('Fix request');
  });

  it('renders "Marked fixed by @x on <date>: <note>" when a note is present', () => {
    const md = renderQaReportMarkdown(
      report({
        defects: [
          defect({
            fixRequest: {
              requestedAt: '2026-09-24T10:00:00.000Z',
              requestedBy: { id: 'dev-1', login: 'dev-bob' },
              note: 'Patched the race condition.',
            },
          }),
        ],
      }),
    );
    expect(md).toContain(
      '**Fix request:** Marked fixed by @dev-bob on 2026-09-24 10:00:00 UTC: Patched the race condition.',
    );
  });

  it('drops the trailing colon when the fix request has no note', () => {
    const md = renderQaReportMarkdown(
      report({
        defects: [
          defect({
            fixRequest: {
              requestedAt: '2026-09-24T10:00:00.000Z',
              requestedBy: { id: 'dev-1', login: 'dev-bob' },
              note: null,
            },
          }),
        ],
      }),
    );
    expect(md).toContain(
      '**Fix request:** Marked fixed by @dev-bob on 2026-09-24 10:00:00 UTC.',
    );
  });

  it('orders defects severity-first, matching report.defects verbatim (the mapper already sorted them)', () => {
    const md = renderQaReportMarkdown(
      report({
        defects: [
          defect({ title: 'first', severity: 'blocker' }),
          defect({ title: 'second', severity: 'minor' }),
        ],
      }),
    );
    expect(md.indexOf('— first')).toBeLessThan(md.indexOf('— second'));
  });
});

describe('renderQaReportMarkdown / sign-off', () => {
  it('says "Not signed off." for an open run with no history', () => {
    const md = renderQaReportMarkdown(report());
    expect(md).toContain('## Sign-off\n\nNot signed off.');
  });

  it('renders verdict, summary, and signed-off-by for an APPROVED sign-off', () => {
    const signedOffRun = run({
      status: 'signed_off',
      signoff: {
        id: 'signoff-1',
        verdict: 'APPROVED',
        summary: 'All green.',
        conditions: null,
        signedBy: { id: 'qa-1', login: 'qa-alice' },
        signedAt: '2026-09-25T05:00:00.000Z',
      },
    });
    const md = renderQaReportMarkdown(report({ run: signedOffRun }));
    expect(md).toContain('**Verdict:** APPROVED');
    expect(md).toContain('**Summary:** All green.');
    expect(md).toContain(
      '**Signed off by:** @qa-alice on 2026-09-25 05:00:00 UTC',
    );
    expect(md).not.toContain('**Conditions:**');
  });

  it('includes Conditions only for a CONDITIONAL verdict', () => {
    const signedOffRun = run({
      status: 'signed_off',
      signoff: {
        id: 'signoff-1',
        verdict: 'CONDITIONAL',
        summary: null,
        conditions: 'Fix the login timeout before release.',
        signedBy: { id: 'qa-1', login: 'qa-alice' },
        signedAt: '2026-09-25T05:00:00.000Z',
      },
    });
    const md = renderQaReportMarkdown(report({ run: signedOffRun }));
    expect(md).toContain(
      '**Conditions:** Fix the login timeout before release.',
    );
  });

  it('lists previous sign-offs oldest first, resolving supersededBy', () => {
    const history: QaReportSignoffHistoryEntry[] = [
      {
        verdict: 'REJECTED',
        summary: null,
        conditions: null,
        signedBy: { id: 'qa-1', login: 'qa-alice' },
        signedAt: '2026-09-20T00:00:00.000Z',
        supersededAt: '2026-09-21T00:00:00.000Z',
        supersededBy: { id: 'lead-1', login: 'lead-bob' },
      },
      {
        verdict: 'REJECTED',
        summary: null,
        conditions: null,
        signedBy: { id: 'qa-1', login: 'qa-alice' },
        signedAt: '2026-09-22T00:00:00.000Z',
        supersededAt: '2026-09-23T00:00:00.000Z',
        // Pre-migration row: superseded_by was stored, its login was not.
        supersededBy: { id: 'lead-2', login: null },
      },
    ];
    const md = renderQaReportMarkdown(report({ signoffHistory: history }));

    expect(md).toContain('### Previous sign-offs');
    expect(md).toContain(
      '- REJECTED by @qa-alice on 2026-09-20 00:00:00 UTC — superseded 2026-09-21 00:00:00 UTC by @lead-bob',
    );
    expect(md).toContain(
      '- REJECTED by @qa-alice on 2026-09-22 00:00:00 UTC — superseded 2026-09-23 00:00:00 UTC by user lead-2',
    );
    // Oldest first: the 09-20 entry's line appears before the 09-22 one.
    expect(md.indexOf('2026-09-20 00:00:00 UTC —')).toBeLessThan(
      md.indexOf('2026-09-22 00:00:00 UTC —'),
    );
  });

  it('omits the "Previous sign-offs" section entirely when history is empty', () => {
    const md = renderQaReportMarkdown(report({ signoffHistory: [] }));
    expect(md).not.toContain('Previous sign-offs');
  });
});

describe('renderQaReportMarkdown / document shape', () => {
  it('is deterministic: the same report renders identical output twice', () => {
    const fixture = report();
    expect(renderQaReportMarkdown(fixture)).toBe(
      renderQaReportMarkdown(fixture),
    );
  });

  it('ends with exactly one trailing newline', () => {
    const md = renderQaReportMarkdown(report());
    expect(md.endsWith('\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('contains every top-level section heading, in order', () => {
    const md = renderQaReportMarkdown(report());
    const headings = [
      '# QA report',
      '## Executive summary',
      '## Checklist',
      '## Automated results',
      '## Defects',
      '## Sign-off',
    ];
    const positions = headings.map((h) => md.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
