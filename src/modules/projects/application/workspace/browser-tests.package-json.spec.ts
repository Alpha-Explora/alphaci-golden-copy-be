import {
  isFrontendPackage,
  readPlaywrightVersion,
  updatePackageJson,
} from './browser-tests.package-json';

const pkg = (value: object): string => JSON.stringify(value, null, 2) + '\n';

describe('updatePackageJson', () => {
  it('adds both devDependencies and the test:e2e script, keeping indent and trailing newline', () => {
    const result = updatePackageJson(
      JSON.stringify(
        { name: 'a', devDependencies: { jest: '^29.0.0' } },
        null,
        4,
      ) + '\n',
    );
    expect(result?.changed).toBe(true);
    expect(result?.content.startsWith('{\n    "name"')).toBe(true);
    expect(result?.content.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(result!.content) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(parsed.devDependencies['@playwright/test']).toBe('^1.55.0');
    expect(parsed.devDependencies['@axe-core/playwright']).toBe('^4.10.0');
    expect(parsed.devDependencies.jest).toBe('^29.0.0');
    expect(parsed.scripts['test:e2e']).toBe('playwright test');
  });

  it('never downgrades a newer version and keeps an existing script', () => {
    const raw = pkg({
      scripts: { 'test:e2e': 'playwright test --headed' },
      devDependencies: {
        '@playwright/test': '^1.60.2',
        '@axe-core/playwright': '^4.10.0',
      },
    });
    const result = updatePackageJson(raw);
    expect(result).toEqual({ content: raw, changed: false });
  });

  it('raises an older playwright but leaves an incomparable range alone', () => {
    const older = updatePackageJson(
      pkg({ devDependencies: { '@playwright/test': '^1.49.0' } }),
    );
    expect(
      (
        JSON.parse(older!.content) as {
          devDependencies: Record<string, string>;
        }
      ).devDependencies['@playwright/test'],
    ).toBe('^1.55.0');

    const latest = updatePackageJson(
      pkg({
        scripts: { 'test:e2e': 'x' },
        devDependencies: {
          '@playwright/test': 'latest',
          '@axe-core/playwright': '^4.10.0',
        },
      }),
    );
    expect(latest?.changed).toBe(false);
  });

  it('returns null for text that is not a JSON object', () => {
    expect(updatePackageJson('not json')).toBeNull();
    expect(updatePackageJson('[]')).toBeNull();
  });
});

describe('package.json readers', () => {
  it('recognises next or react as a frontend', () => {
    expect(isFrontendPackage(pkg({ dependencies: { next: '15' } }))).toBe(true);
    expect(isFrontendPackage(pkg({ devDependencies: { react: '19' } }))).toBe(
      true,
    );
    expect(
      isFrontendPackage(pkg({ dependencies: { '@nestjs/core': '11' } })),
    ).toBe(false);
    expect(isFrontendPackage(null)).toBe(false);
  });

  it('reads the playwright range', () => {
    expect(
      readPlaywrightVersion(
        pkg({ devDependencies: { '@playwright/test': '^1.50.0' } }),
      ),
    ).toBe('^1.50.0');
    expect(readPlaywrightVersion(pkg({}))).toBeNull();
  });
});
