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

const automation = (
  overrides: Partial<QaRunAutomation> = {},
): QaRunAutomation => ({
  verify: null,
  quality: null,
  ...overrides,
});

describe('matchAutomatedResult — manual items', () => {
  it('is always null, regardless of testIdentifier or automation', () => {
    expect(
      matchAutomatedResult(
        { verificationType: 'manual', testIdentifier: 'e2e/a.spec.ts' },
        automation({ verify: stage() }),
      ),
    ).toBeNull();
  });
});

describe('matchAutomatedResult — playwright, stage-level branches', () => {
  it('is not_run with scope stage when there is no verify report', () => {
    const result = matchAutomatedResult(
      { verificationType: 'playwright', testIdentifier: 'e2e/a.spec.ts' },
      automation(),
    );
    expect(result).toEqual({
      source: 'playwright',
      stage: 'verify',
      status: 'not_run',
      scope: 'stage',
      matchedSpec: null,
      failure: null,
      runId: null,
      runUrl: null,
      reportedAt: null,
    });
  });

  it.each(['running', 'cancelled'] as const)(
    'is unknown with scope stage when the verify report is %s',
    (status) => {
      const report = stage({ status });
      const result = matchAutomatedResult(
        { verificationType: 'playwright', testIdentifier: 'e2e/a.spec.ts' },
        automation({ verify: report }),
      );
      expect(result?.status).toBe('unknown');
      expect(result?.scope).toBe('stage');
      expect(result?.runId).toBe(report.runId);
    },
  );

  it('follows the stage status (not counts) when tests is null', () => {
    const passing = matchAutomatedResult(
      { verificationType: 'playwright', testIdentifier: 'e2e/a.spec.ts' },
      automation({ verify: stage({ status: 'success', tests: null }) }),
    );
    expect(passing).toMatchObject({ status: 'passed', scope: 'stage' });

    const failing = matchAutomatedResult(
      { verificationType: 'playwright', testIdentifier: 'e2e/a.spec.ts' },
      automation({ verify: stage({ status: 'failure', tests: null }) }),
    );
    expect(failing).toMatchObject({ status: 'failed', scope: 'stage' });
  });

  it('follows the stage status (not counts) when tests.total is 0', () => {
    const report = stage({
      status: 'success',
      tests: {
        total: 0,
        passed: 0,
        failed: 0,
        failures: [],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      { verificationType: 'playwright', testIdentifier: 'e2e/a.spec.ts' },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({ status: 'passed', scope: 'stage' });
  });

  it('uses counts (not stage status) when tests are present but the item has no test_identifier', () => {
    const failingCounts = stage({
      status: 'success', // stage still reports success overall in this fixture
      tests: {
        total: 5,
        passed: 4,
        failed: 1,
        failures: [
          { name: 'e2e/other.spec.ts > Suite > Case', message: 'boom' },
        ],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      { verificationType: 'playwright', testIdentifier: null },
      automation({ verify: failingCounts }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      scope: 'stage',
      matchedSpec: null,
    });

    const passingCounts = stage({
      tests: {
        total: 5,
        passed: 5,
        failed: 0,
        failures: [],
        failuresTruncated: false,
      },
    });
    const passingResult = matchAutomatedResult(
      { verificationType: 'playwright', testIdentifier: null },
      automation({ verify: passingCounts }),
    );
    expect(passingResult).toMatchObject({ status: 'passed', scope: 'stage' });
  });
});

describe('matchAutomatedResult — playwright, spec matching', () => {
  it('matches a failure by exact file and returns the first matching failure', () => {
    const report = stage({
      tests: {
        total: 3,
        passed: 1,
        failed: 2,
        failures: [
          {
            name: 'e2e/checkout.spec.ts > Checkout > pays with a saved card',
            message: 'timeout',
          },
          {
            name: 'e2e/checkout.spec.ts > Checkout > applies a coupon',
            message: 'assertion failed',
          },
        ],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier:
          'e2e/checkout.spec.ts › Checkout › pays with a saved card',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      scope: 'spec',
      matchedSpec: 'e2e/checkout.spec.ts',
      failure: {
        name: 'e2e/checkout.spec.ts > Checkout > pays with a saved card',
        message: 'timeout',
      },
    });
  });

  it('matches when the item names only the basename and the failure carries a directory prefix', () => {
    const report = stage({
      tests: {
        total: 1,
        passed: 0,
        failed: 1,
        failures: [
          {
            name: 'e2e/checkout.spec.ts > Checkout > pays',
            message: 'timeout',
          },
        ],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'checkout.spec.ts › Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({ status: 'failed', scope: 'spec' });
  });

  it('matches when the item names a directory prefix and the failure carries only the basename', () => {
    const report = stage({
      tests: {
        total: 1,
        passed: 0,
        failed: 1,
        failures: [
          { name: 'checkout.spec.ts > Checkout > pays', message: 'timeout' },
        ],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'e2e/checkout.spec.ts › Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({ status: 'failed', scope: 'spec' });
  });

  it('splits test_identifier on whichever of " › " / " > " appears first', () => {
    const report = stage({
      tests: {
        total: 1,
        passed: 0,
        failed: 1,
        failures: [
          {
            name: 'e2e/checkout.spec.ts > Checkout > pays',
            message: 'timeout',
          },
        ],
        failuresTruncated: false,
      },
    });
    // " > " appears before " › " here — the file segment must still be
    // exactly "e2e/checkout.spec.ts", not "e2e/checkout.spec.ts > Checkout".
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'e2e/checkout.spec.ts > Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      scope: 'spec',
      matchedSpec: 'e2e/checkout.spec.ts',
    });
  });

  it('normalizes backslashes and a leading "./" on both sides before comparing', () => {
    const report = stage({
      tests: {
        total: 1,
        passed: 0,
        failed: 1,
        failures: [
          {
            name: './e2e\\checkout.spec.ts > Checkout > pays',
            message: 'timeout',
          },
        ],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'e2e\\checkout.spec.ts › Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({ status: 'failed', scope: 'spec' });
  });

  it('is passed with scope suite when there is no match and failed is 0', () => {
    const report = stage({
      tests: {
        total: 4,
        passed: 4,
        failed: 0,
        failures: [],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'e2e/checkout.spec.ts › Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({
      status: 'passed',
      scope: 'suite',
      matchedSpec: null,
    });
  });

  it('is passed with scope spec when there is no match, failed > 0, and the failures list is complete', () => {
    const report = stage({
      tests: {
        total: 4,
        passed: 3,
        failed: 1,
        failures: [
          { name: 'e2e/other.spec.ts > Suite > Case', message: 'boom' },
        ],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'e2e/checkout.spec.ts › Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({
      status: 'passed',
      scope: 'spec',
      matchedSpec: 'e2e/checkout.spec.ts',
      failure: null,
    });
  });

  it('is unknown with scope suite when there is no match and the failures list is truncated', () => {
    const report = stage({
      tests: {
        total: 30,
        passed: 5,
        failed: 25,
        failures: [
          { name: 'e2e/other.spec.ts > Suite > Case', message: 'boom' },
        ],
        failuresTruncated: true,
      },
    });
    const result = matchAutomatedResult(
      {
        verificationType: 'playwright',
        testIdentifier: 'e2e/checkout.spec.ts › Checkout › pays',
      },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({
      status: 'unknown',
      scope: 'suite',
      matchedSpec: null,
    });
  });
});

describe('matchAutomatedResult — bruno (stage-level only, verify stage)', () => {
  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
  ] as const)('maps stage status %s to %s', (stageStatus, expected) => {
    const result = matchAutomatedResult(
      { verificationType: 'bruno', testIdentifier: null },
      automation({ verify: stage({ status: stageStatus }) }),
    );
    expect(result).toMatchObject({
      source: 'bruno',
      stage: 'verify',
      status: expected,
      scope: 'stage',
    });
  });

  it('is not_run when there is no verify report', () => {
    const result = matchAutomatedResult(
      { verificationType: 'bruno', testIdentifier: null },
      automation(),
    );
    expect(result).toMatchObject({ status: 'not_run', scope: 'stage' });
  });

  it.each(['running', 'cancelled'] as const)(
    'is unknown when the verify report is %s',
    (status) => {
      const result = matchAutomatedResult(
        { verificationType: 'bruno', testIdentifier: null },
        automation({ verify: stage({ status }) }),
      );
      expect(result).toMatchObject({ status: 'unknown', scope: 'stage' });
    },
  );

  it('ignores testIdentifier and tests counts entirely — stage-level only', () => {
    const report = stage({
      status: 'success',
      tests: {
        total: 5,
        passed: 0,
        failed: 5,
        failures: [],
        failuresTruncated: false,
      },
    });
    const result = matchAutomatedResult(
      { verificationType: 'bruno', testIdentifier: 'requests/checkout.bru' },
      automation({ verify: report }),
    );
    expect(result).toMatchObject({ status: 'passed', scope: 'stage' });
  });
});

describe('matchAutomatedResult — unit_test (stage-level only, quality stage)', () => {
  it.each([
    ['success', 'passed'],
    ['failure', 'failed'],
  ] as const)('maps stage status %s to %s', (stageStatus, expected) => {
    const result = matchAutomatedResult(
      { verificationType: 'unit_test', testIdentifier: null },
      automation({ quality: stage({ stage: 'quality', status: stageStatus }) }),
    );
    expect(result).toMatchObject({
      source: 'unit_test',
      stage: 'quality',
      status: expected,
      scope: 'stage',
    });
  });

  it('is not_run when there is no quality report', () => {
    const result = matchAutomatedResult(
      { verificationType: 'unit_test', testIdentifier: null },
      automation(),
    );
    expect(result).toMatchObject({ status: 'not_run', scope: 'stage' });
  });

  it.each(['running', 'cancelled'] as const)(
    'is unknown when the quality report is %s',
    (status) => {
      const result = matchAutomatedResult(
        { verificationType: 'unit_test', testIdentifier: null },
        automation({ quality: stage({ stage: 'quality', status }) }),
      );
      expect(result).toMatchObject({ status: 'unknown', scope: 'stage' });
    },
  );

  it('reads the quality slot, never verify, even when both are present', () => {
    const result = matchAutomatedResult(
      { verificationType: 'unit_test', testIdentifier: null },
      automation({
        verify: stage({ status: 'failure' }),
        quality: stage({ stage: 'quality', status: 'success' }),
      }),
    );
    expect(result).toMatchObject({ stage: 'quality', status: 'passed' });
  });
});
