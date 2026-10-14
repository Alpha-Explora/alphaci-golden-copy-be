import {
  canStartNextIteration,
  isIterationWritable,
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
