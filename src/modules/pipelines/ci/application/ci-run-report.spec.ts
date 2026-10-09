import {
  buildCiRunReport,
  buildCiRunReportFilename,
  renderCiRunReportMarkdown,
  CI_RUN_REPORT_SCHEMA_VERSION,
} from './ci-run-report';
import type { RunGroup, StageReport } from './ci-reports.service';

const GENERATED_AT = '2026-10-09T09:00:00.000Z';

function stage(overrides: Partial<StageReport>): StageReport {
  return {
    stage: 'access',
    status: 'success',
    runId: 100,
    friendlyMessages: [],
    githubRunUrl: 'https://github.com/acme/orders-api/actions/runs/100',
    updatedAt: '2026-10-09T08:00:00.000Z',
    rawLogs: null,
    checks: [],
    ...overrides,
  };
}

function run(
  stages: StageReport[],
  overrides: Partial<RunGroup> = {},
): RunGroup {
  return {
    runId: 300,
    repoFullName: 'acme/orders-api',
    branch: 'uat',
    commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    startedAt: '2026-10-09T07:55:00.000Z',
    overallStatus: 'failure',
    stages,
    ...overrides,
  };
}

const FAILED_QUALITY = stage({
  stage: 'quality',
  status: 'failure',
  runId: 200,
  rawLogs: 'token=ghp_secretvalue',
  friendlyMessages: [
    {
      severity: 'error',
      title: '2 tests failed',
      detail: 'Two checkout tests did not pass.',
      hint: 'Fix the failing tests, then re-run.',
      items: [
        { label: 'checkout › pays', sub: 'Timed out' },
        { label: 'cart › coupon' },
      ],
    },
    { severity: 'info', title: 'Coverage unchanged', detail: '', hint: '' },
  ],
  checks: [
    { name: 'Unit tests', conclusion: 'failure' },
    { name: 'Lint', conclusion: 'success' },
  ],
  results: {
    tests: {
      passed: 18,
      failed: 2,
      total: 20,
      failures: [{ name: 'checkout › pays', message: 'Timed out' }],
    },
    coverage: { pct: 81.5, threshold: 80 },
    lint: { errors: 0, warnings: 3 },
    security: { high: 1, critical: 0 },
    findings: { secrets: 0, forbiddenLicenses: 1, undeterminedLicenses: 2 },
    sonar: {
      gate: 'ERROR',
      failedConditions: [
        { metric: 'new_coverage', actual: '60', threshold: '80' },
        { metric: 'new_bugs' },
      ],
    },
  },
});

const STAGES: StageReport[] = [
  stage({ stage: 'access' }),
  FAILED_QUALITY,
  stage({
    stage: 'package',
    status: 'blocked',
    updatedAt: '',
    runId: 200,
    friendlyMessages: [
      {
        severity: 'warning',
        title: 'Blocked',
        detail: 'Quality failed.',
        hint: '',
      },
    ],
  }),
  stage({ stage: 'verify', status: 'pending', updatedAt: '' }),
];

describe('buildCiRunReport', () => {
  const report = buildCiRunReport({
    generatedAt: GENERATED_AT,
    run: run(STAGES),
  });

  it('identifies the execution and carries the clock it was given', () => {
    expect(report.schemaVersion).toBe(CI_RUN_REPORT_SCHEMA_VERSION);
    expect(report.generatedAt).toBe(GENERATED_AT);
    expect(report.repoFullName).toBe('acme/orders-api');
    expect(report.branch).toBe('uat');
    expect(report.overallStatus).toBe('failure');
  });

  it('counts the stages by outcome', () => {
    expect(report.summary).toEqual({
      stages: 4,
      passed: 1,
      failed: 1,
      inProgress: 0,
      notRun: 2,
    });
  });

  it('lists only the failed stage first, and only its error messages', () => {
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      stage: 'quality',
      severity: 'error',
      title: '2 tests failed',
      hint: 'Fix the failing tests, then re-run.',
    });
    expect(report.failures[0]?.items).toHaveLength(2);
  });

  it("falls back to a failed stage's other messages when none is an error", () => {
    const only = buildCiRunReport({
      generatedAt: GENERATED_AT,
      run: run([
        stage({
          stage: 'quality',
          status: 'failure',
          friendlyMessages: [
            {
              severity: 'warning',
              title: 'Job failed',
              detail: 'd',
              hint: 'h',
            },
          ],
        }),
      ]),
    });
    expect(only.failures.map((failure) => failure.title)).toEqual([
      'Job failed',
    ]);
  });

  it('lists nothing as a failure for a run that passed or was blocked', () => {
    const clean = buildCiRunReport({
      generatedAt: GENERATED_AT,
      run: run([stage({ stage: 'access' }), STAGES[2]!], {
        overallStatus: 'success',
      }),
    });
    expect(clean.failures).toEqual([]);
  });

  it('keeps every stage in pipeline order, null for one that never reported', () => {
    expect(report.stages.map((entry) => entry.stage)).toEqual([
      'access',
      'quality',
      'package',
      'verify',
    ]);
    expect(report.stages[2]?.reportedAt).toBeNull();
    expect(report.stages[1]?.reportedAt).toBe('2026-10-09T08:00:00.000Z');
  });

  it('never carries the raw logs, only whether there are any', () => {
    expect(report.stages[1]?.hasLogs).toBe(true);
    expect(report.stages[0]?.hasLogs).toBe(false);
    expect(JSON.stringify(report)).not.toContain('ghp_secretvalue');
  });

  it('never links to GitHub', () => {
    expect(JSON.stringify(report)).not.toContain('github.com');
    expect(renderCiRunReportMarkdown(report)).not.toContain('github.com');
  });
});

describe('renderCiRunReportMarkdown', () => {
  const markdown = renderCiRunReportMarkdown(
    buildCiRunReport({ generatedAt: GENERATED_AT, run: run(STAGES) }),
  );

  it('opens with the execution and its result', () => {
    expect(markdown).toContain('# CI results: acme/orders-api · uat @ a1b2c3d');
    expect(markdown).toContain(
      '**Result:** Failed · 1 of 4 stages passed, 1 failed, 2 not run',
    );
  });

  it('puts the failures before the stages, each with its fix', () => {
    expect(markdown.indexOf('## Failures')).toBeLessThan(
      markdown.indexOf('## Stages'),
    );
    expect(markdown).toContain('### Quality: 2 tests failed');
    expect(markdown).toContain('**Fix:** Fix the failing tests, then re-run.');
    expect(markdown).toContain('- checkout › pays: Timed out');
    expect(markdown).toContain('- cart › coupon');
  });

  it('says so when nothing failed', () => {
    const clean = renderCiRunReportMarkdown(
      buildCiRunReport({
        generatedAt: GENERATED_AT,
        run: run([stage({})], { overallStatus: 'success' }),
      }),
    );
    expect(clean).toContain('No failed stages.');
    expect(clean).toContain('**Result:** Passed · 1 of 1 stages passed');
  });

  it('draws every figure a stage reported', () => {
    expect(markdown).toContain('- **Tests:** 18 / 20 passed, 2 failed');
    expect(markdown).toContain('  - checkout › pays: Timed out');
    expect(markdown).toContain('- **Coverage:** 81.5% (threshold 80%)');
    expect(markdown).toContain('- **Lint:** 0 errors, 3 warnings');
    expect(markdown).toContain(
      '- **Dependency vulnerabilities:** 0 critical, 1 high',
    );
    expect(markdown).toContain(
      '- **Findings:** 0 secrets, 1 forbidden licences, 2 undetermined licences',
    );
    expect(markdown).toContain('- **SonarCloud quality gate:** ERROR');
    // Conditions in words, with the metric's unit.
    expect(markdown).toContain(
      '  - Failed: Coverage on new code 60% (needs 80%)',
    );
    expect(markdown).toContain('  - Failed: New bugs');
  });

  it('draws the per-tool checks as a table', () => {
    expect(markdown).toContain('| Unit tests | failure |');
    expect(markdown).toContain('| Lint | success |');
  });

  it('says a stage with no figures reported none', () => {
    expect(markdown).toContain('### Verify — Not run yet');
    expect(markdown).toContain('No figures were reported for this stage.');
  });

  it('escapes a pipe or newline in a table cell so the table holds', () => {
    const odd = renderCiRunReportMarkdown(
      buildCiRunReport({
        generatedAt: GENERATED_AT,
        run: run([
          stage({
            stage: 'quality',
            checks: [{ name: 'a|b\nc', conclusion: 'success' }],
          }),
        ]),
      }),
    );
    expect(odd).toContain('| a\\|b<br>c | success |');
  });

  it('ends with the schema version', () => {
    expect(markdown.trimEnd().endsWith('_ci-run-report/v1_')).toBe(true);
  });
});

describe('buildCiRunReportFilename', () => {
  it('names the repo (not owner/repo), branch and short sha', () => {
    const report = {
      repoFullName: 'acme/orders-api',
      branch: 'uat',
      commitSha: 'a1b2c3d4e5',
    };
    expect(buildCiRunReportFilename(report, 'md')).toBe(
      'CI-Results-orders-api-uat-a1b2c3d.md',
    );
    expect(buildCiRunReportFilename(report, 'json')).toBe(
      'CI-Results-orders-api-uat-a1b2c3d.json',
    );
  });

  it('sanitises every part, so a branch with slashes cannot escape the name', () => {
    const name = buildCiRunReportFilename(
      { repoFullName: 'acme/orders api', branch: '../feat/x y', commitSha: '' },
      'json',
    );
    expect(name).toBe('CI-Results-orders-api-feat-x-y-unknown.json');
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('real driver shapes', () => {
  // pg returns timestamptz columns as Date objects although StageReport types
  // them as strings; the first real run crashed the Markdown renderer.
  const asDate = (iso: string) => new Date(iso) as unknown as string;

  it('turns Date timestamps into ISO strings and still renders Markdown', () => {
    const report = buildCiRunReport({
      generatedAt: GENERATED_AT,
      run: run(
        [
          stage({
            stage: 'access',
            updatedAt: asDate('2026-10-09T08:00:00.000Z'),
          }),
          stage({ stage: 'verify', status: 'pending', updatedAt: '' }),
        ],
        { startedAt: asDate('2026-10-09T07:55:00.000Z') },
      ),
    });

    expect(report.stages[0]?.reportedAt).toBe('2026-10-09T08:00:00.000Z');
    expect(report.stages[1]?.reportedAt).toBeNull();
    expect(report.startedAt).toBe('2026-10-09T07:55:00.000Z');
    const markdown = renderCiRunReportMarkdown(report);
    expect(markdown).toContain(
      '| Access | Passed | 2026-10-09T08:00:00.000Z |',
    );
    expect(markdown).toContain('Started 2026-10-09T07:55:00.000Z');
  });

  it('renders a stored value that is not a string instead of failing the download', () => {
    const report = buildCiRunReport({
      generatedAt: GENERATED_AT,
      run: run([
        stage({
          stage: 'quality',
          status: 'failure',
          friendlyMessages: [
            {
              severity: 'error',
              title: 'Tests failed',
              detail: 'd',
              hint: 'h',
              items: [{ label: 42 as unknown as string }],
            },
          ],
          checks: [{ name: 'Unit', conclusion: null as unknown as string }],
        }),
      ]),
    });

    const markdown = renderCiRunReportMarkdown(report);
    expect(markdown).toContain('- 42');
    expect(markdown).toContain('| Unit | — |');
  });
});
