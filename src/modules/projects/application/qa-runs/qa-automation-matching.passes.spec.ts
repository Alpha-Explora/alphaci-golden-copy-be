import { matchAutomatedResult } from './qa-automation-matching';
import type { QaRunAutomation, QaStageAutomation } from './qa-runs.contracts';

const stage = (
  overrides: Partial<QaStageAutomation> = {},
): QaStageAutomation => ({
  stage: 'verify',
  status: 'success',
  runId: 42,
  runUrl: 'https://github.com/acme/repo/actions/runs/42',
  reportedAt: '2026-09-25T00:00:00.000Z',
  tests: null,
  ...overrides,
});

const automation = (verify: QaStageAutomation): QaRunAutomation => ({
  verify,
  quality: null,
});

type Tests = NonNullable<QaStageAutomation['tests']>;

const item = (testIdentifier: string | null) => ({
  verificationType: 'playwright' as const,
  testIdentifier,
});

const run = (
  tests: Partial<Tests>,
  status: QaStageAutomation['status'] = 'failure',
) =>
  automation(
    stage({
      status,
      tests: {
        total: 5,
        passed: 3,
        failed: 2,
        failures: [],
        failuresTruncated: false,
        ...tests,
      },
    }),
  );

describe('matchAutomatedResult - playwright, confirmed passes', () => {
  it('passes only when a passing name matches the spec file', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts'),
      run({
        passes: ['e2e/checkout.spec.ts > pays by card'],
        failures: [{ name: 'e2e/login.spec.ts > fails', message: 'x' }],
        passed: 1,
        failed: 1,
        total: 2,
      }),
    );
    expect(result).toMatchObject({
      status: 'passed',
      scope: 'spec',
      matchedSpec: 'e2e/checkout.spec.ts',
    });
    expect(result?.inferred).toBeUndefined();
  });

  it('is not_run when the spec is in neither list (the old inference said passed)', () => {
    const result = matchAutomatedResult(
      item('e2e/ghost.spec.ts'),
      run({
        passes: ['e2e/checkout.spec.ts > pays'],
        failures: [{ name: 'e2e/login.spec.ts > f', message: 'x' }],
        passed: 1,
        failed: 1,
        total: 2,
      }),
    );
    expect(result).toMatchObject({ status: 'not_run', scope: 'spec' });
  });

  it('fails when a failure matches the spec file, even if another test in it passed', () => {
    const result = matchAutomatedResult(
      item('checkout.spec.ts'),
      run({
        passes: ['e2e/checkout.spec.ts > a'],
        failures: [{ name: 'e2e/checkout.spec.ts > b', message: 'boom' }],
        passed: 1,
        failed: 1,
        total: 2,
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      failure: { name: 'e2e/checkout.spec.ts > b', message: 'boom' },
    });
  });

  it('matches the specific test the item names: a passing test beats a sibling failure', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts > checkout > pays by card'),
      run({
        passes: ['e2e/checkout.spec.ts > checkout > pays by card'],
        failures: [
          {
            name: 'e2e/checkout.spec.ts > checkout > pays by cash',
            message: 'x',
          },
        ],
        passed: 1,
        failed: 1,
        total: 2,
      }),
    );
    expect(result?.status).toBe('passed');
  });

  it('matches a specific failing test, accepting an item that omits the describe blocks', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts › pays by cash'),
      run({
        passes: ['e2e/checkout.spec.ts > checkout > pays by card'],
        failures: [
          {
            name: 'e2e/checkout.spec.ts > checkout > pays by cash',
            message: 'x',
          },
        ],
        passed: 1,
        failed: 1,
        total: 2,
      }),
    );
    expect(result?.status).toBe('failed');
  });

  it('falls back to the spec file when the named test is in neither list', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts > renamed test'),
      run(
        {
          passes: ['e2e/checkout.spec.ts > old name'],
          passed: 1,
          failed: 0,
          total: 1,
        },
        'success',
      ),
    );
    expect(result?.status).toBe('passed');
  });

  it('is unknown, not passed, when the failure list is truncated and none named the file', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts'),
      run({
        passes: ['e2e/checkout.spec.ts > a'],
        failures: [{ name: 'e2e/x.spec.ts > f', message: '' }],
        failed: 9,
        failuresTruncated: true,
      }),
    );
    expect(result?.status).toBe('unknown');
  });

  it('is unknown, not not_run, when the pass list is a prefix', () => {
    const result = matchAutomatedResult(
      item('e2e/ghost.spec.ts'),
      run(
        {
          passes: ['e2e/a.spec.ts > a'],
          passed: 400,
          failed: 0,
          total: 400,
        },
        'success',
      ),
    );
    expect(result?.status).toBe('unknown');
  });

  it('with no test identifier is unlinked, whatever the stage did', () => {
    const result = matchAutomatedResult(
      item(null),
      run({ passes: [], passed: 0, failed: 2 }),
    );
    expect(result).toMatchObject({ status: 'unlinked', scope: 'stage' });
  });
});

describe('matchAutomatedResult - playwright, inferred passes (none reported)', () => {
  const tests = (overrides: Partial<Tests> = {}): Tests => ({
    total: 4,
    passed: 3,
    failed: 1,
    failures: [{ name: 'e2e/login.spec.ts > f', message: 'x' }],
    failuresTruncated: false,
    ...overrides,
  });

  it('keeps the inference and marks it inferred', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts'),
      automation(stage({ status: 'failure', tests: tests() })),
    );
    expect(result).toMatchObject({
      status: 'passed',
      scope: 'spec',
      inferred: true,
    });
  });

  it('marks the all-green suite pass inferred too', () => {
    const result = matchAutomatedResult(
      item('e2e/checkout.spec.ts'),
      automation(
        stage({ tests: tests({ failed: 0, passed: 4, failures: [] }) }),
      ),
    );
    expect(result).toMatchObject({
      status: 'passed',
      scope: 'suite',
      inferred: true,
    });
  });

  it('does not mark a named failure as inferred', () => {
    const result = matchAutomatedResult(
      item('e2e/login.spec.ts'),
      automation(stage({ status: 'failure', tests: tests() })),
    );
    expect(result?.status).toBe('failed');
    expect(result?.inferred).toBeUndefined();
  });
});
