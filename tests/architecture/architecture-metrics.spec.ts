import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface ModuleMetrics {
  module: string;
  crossModuleImports: number;
  crossContextPairs: string[];
  crossContextPairCount: number;
}

const root = join(__dirname, '..', '..');
const node = process.execPath;

describe('architecture metrics', () => {
  it('counts aliased and relative cross-context imports instead of reporting a false zero', () => {
    const output = execFileSync(
      node,
      [join(root, 'scripts', 'report-architecture-metrics.cjs'), '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    const metrics = JSON.parse(output) as ModuleMetrics[];
    const projects = metrics.find((item) => item.module === 'projects');

    expect(projects).toBeDefined();
    expect(projects!.crossModuleImports).toBeGreaterThan(0);
    expect(projects!.crossContextPairCount).toBeGreaterThan(0);
    expect(projects!.crossContextPairs).toContain('projects->runtime');
  });

  it('prints the distinct cross-context pair count in the human-readable report', () => {
    const output = execFileSync(
      node,
      [join(root, 'scripts', 'report-architecture-metrics.cjs')],
      { cwd: root, encoding: 'utf8' },
    );

    expect(output).toContain('cross-context pairs');
    expect(output).toMatch(/Totals: .*crossContextPairCount/);
  });
});
