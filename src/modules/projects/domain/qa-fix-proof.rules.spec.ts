import { acceptsFixProof } from './qa-fix-proof.rules';

const REQUESTED = '2026-10-14T09:00:00.000Z';

describe('acceptsFixProof', () => {
  it.each([
    ['returned_to_dev', null],
    ['returned_to_dev', REQUESTED],
    ['pending', REQUESTED],
  ])('accepts a %s item (fix request: %s)', (status, fix_requested_at) => {
    expect(acceptsFixProof({ status, fix_requested_at })).toBe(true);
  });

  it.each([
    ['pending', null],
    ['in_progress', null],
    ['in_progress', REQUESTED],
    ['passed', REQUESTED],
    ['passed', null],
    ['failed', null],
    ['failed', REQUESTED],
    ['blocked', null],
  ])('refuses a %s item (fix request: %s)', (status, fix_requested_at) => {
    expect(acceptsFixProof({ status, fix_requested_at })).toBe(false);
  });

  it('refuses an unknown status', () => {
    expect(
      acceptsFixProof({ status: 'nonsense', fix_requested_at: null }),
    ).toBe(false);
  });
});
