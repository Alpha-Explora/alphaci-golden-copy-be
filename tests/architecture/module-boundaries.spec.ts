import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('module boundary policy', () => {
  const repositoryRoot = resolve(__dirname, '../..');

  it('keeps the public-entry and kernel rules enabled', () => {
    const config = readFileSync(
      resolve(repositoryRoot, '.dependency-cruiser.cjs'),
      'utf8',
    );

    expect(config).toContain("name: 'no-deep-module-imports'");
    expect(config).toContain("name: 'kernel-must-not-know-features'");
    expect(config).toContain("name: 'no-circular'");
    expect(config).toContain("name: 'no-test-imports-in-src'");
  });

  it('keeps the known baseline structurally valid', () => {
    const baseline = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, '.dependency-cruiser-known-violations.json'),
        'utf8',
      ),
    ) as Array<{ from: string; to?: string; rule?: { name?: string } }>;

    expect(Array.isArray(baseline)).toBe(true);
    expect(baseline.length).toBeGreaterThan(0);
    expect(
      baseline.every(
        (finding) =>
          typeof finding.from === 'string' &&
          (finding.to === undefined || typeof finding.to === 'string') &&
          typeof finding.rule?.name === 'string',
      ),
    ).toBe(true);
  });
});
