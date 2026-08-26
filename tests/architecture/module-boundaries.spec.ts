import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

jest.setTimeout(120_000);

describe('module boundary policy', () => {
  const repositoryRoot = resolve(__dirname, '../..');
  const configPath = resolve(repositoryRoot, '.dependency-cruiser.cjs');

  it('keeps the required rules enabled in the dependency-cruiser config', () => {
    const config: { forbidden: Array<{ name: string }> } = require(configPath);

    const ruleNames = config.forbidden.map((rule) => rule.name);
    expect(ruleNames).toContain('no-deep-module-imports');
    expect(ruleNames).toContain('no-cross-module-deep-imports');
    expect(ruleNames).toContain('kernel-must-not-know-features');
    expect(ruleNames).toContain('no-circular');
    expect(ruleNames).toContain('deployments-domain-is-framework-free');
    expect(ruleNames).toContain('deployments-api-cannot-reach-infrastructure');
    expect(ruleNames).toContain('deployment-providers-are-isolated');
    expect(ruleNames).toContain('no-test-imports-in-src');
  });

  it('passes dependency-cruiser with zero violations', () => {
    // Runs the actual analysis against source code. If a violation exists,
    // execSync throws and this test fails with depcruise's own output.
    // Invoke the local depcruise binary directly (not via npm) so the gate
    // works on machines where npm is not on PATH.
    const nodeCmd = process.execPath;
    const depcruiseJs = resolve(
      repositoryRoot,
      'node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
    );
    try {
      const quote = process.platform === 'win32' ? '"' : "'";
      const q = (value: string) => `${quote}${value}${quote}`;
      execSync(
        `${q(nodeCmd)} ${q(depcruiseJs)} src tests --config ${q(configPath)}`,
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          timeout: 120_000,
          stdio: 'pipe',
        },
      );
      // Reaching here means exit code 0 (zero violations).
    } catch (error: unknown) {
      const output =
        error instanceof Error && 'stdout' in error
          ? String((error as { stdout?: unknown }).stdout)
          : '';
      throw new Error(
        `dependency-cruiser found violations:\n${output || String(error)}`,
      );
    }
  });

  it('keeps the known baseline structurally valid', () => {
    const baseline = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, '.dependency-cruiser-known-violations.json'),
        'utf8',
      ),
    ) as Array<{ from: string; to?: string; rule?: { name?: string } }>;

    expect(Array.isArray(baseline)).toBe(true);
    expect(baseline.length).toBe(0);
  });
});
