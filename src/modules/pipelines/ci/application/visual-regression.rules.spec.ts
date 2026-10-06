import {
  baselineBranchesFor,
  hasPngSignature,
  isSafeSnapshotName,
} from './visual-regression.rules';

describe('visual regression rules', () => {
  it.each([
    'home.png',
    'home-chromium-linux.png',
    'a.b_c-d.png',
    `${'x'.repeat(116)}.png`,
  ])('accepts %s', (name) => {
    expect(isSafeSnapshotName(name)).toBe(true);
  });

  it.each([
    '../x.png',
    'a/b.png',
    'a\\b.png',
    '.hidden.png',
    'x.jpg',
    'x.PNG',
    `${'x'.repeat(117)}.png`,
    '',
    'a b.png',
    'a\0.png',
  ])('rejects %j', (name) => {
    expect(isSafeSnapshotName(name)).toBe(false);
  });

  it('checks the PNG signature, not a content type', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('rest'),
    ]);
    expect(hasPngSignature(png)).toBe(true);
    expect(hasPngSignature(Buffer.from('GIF89a'))).toBe(false);
    expect(hasPngSignature(Buffer.alloc(0))).toBe(false);
  });

  it('lets only main inherit, from uat', () => {
    expect(baselineBranchesFor('main')).toEqual(['main', 'uat']);
    expect(baselineBranchesFor('uat')).toEqual(['uat']);
    expect(baselineBranchesFor('dev')).toEqual(['dev']);
  });
});
