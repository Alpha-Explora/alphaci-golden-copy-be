import {
  CARRY_OVER_RESET_STATUSES,
  canStartNextIteration,
  isIterationWritable,
  isUnfinishedForCarryOver,
} from './project-iteration.rules';

describe('isIterationWritable', () => {
  it('only an active Iteration accepts writes', () => {
    expect(isIterationWritable('active')).toBe(true);
    expect(isIterationWritable('delivered')).toBe(false);
  });
});

describe('canStartNextIteration', () => {
  it.each([
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ])(
    'mayManage=%s hasActiveIteration=%s -> %s',
    (mayManage, hasActiveIteration, expected) => {
      expect(canStartNextIteration({ mayManage, hasActiveIteration })).toBe(
        expected,
      );
    },
  );
});

describe('carry-over rules', () => {
  it('resets exactly the statuses QA failed, blocked or returned', () => {
    expect([...CARRY_OVER_RESET_STATUSES].sort()).toEqual([
      'blocked',
      'failed',
      'returned_to_dev',
    ]);
  });

  it.each([
    ['done', 'passed', false],
    ['done', 'failed', true],
    ['done', 'blocked', true],
    ['done', 'returned_to_dev', true],
    ['done', 'pending', true],
    ['done', null, true],
    ['in_progress', 'passed', true],
    ['todo', null, true],
  ] as const)(
    'progress=%s lastStatus=%s -> suggested %s',
    (progress, lastStatus, expected) => {
      expect(isUnfinishedForCarryOver({ progress, lastStatus })).toBe(expected);
    },
  );
});
