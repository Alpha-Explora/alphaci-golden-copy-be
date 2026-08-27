import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

interface ModuleMetrics {
  module: string;
  crossModuleImports: number;
  compositionCrossContextImports: number;
  contractCrossContextImports: number;
  applicationCrossContextImports: number;
  actionableCrossContextImports: number;
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
    expect(projects!.compositionCrossContextImports).toBeGreaterThan(0);
    expect(projects!.contractCrossContextImports).toBe(0);
    // Cross-context imports are now limited to explicit Nest composition
    // wiring; production application imports and contract imports are zero.
    expect(projects!.actionableCrossContextImports).toBe(0);
  });

  it('reports no application-level cross-context imports across the six contexts', () => {
    const output = execFileSync(
      node,
      [join(root, 'scripts', 'report-architecture-metrics.cjs'), '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    const metrics = JSON.parse(output) as ModuleMetrics[];

    expect(
      metrics.reduce(
        (total, item) => total + item.applicationCrossContextImports,
        0,
      ),
    ).toBe(0);
    expect(
      metrics.reduce(
        (total, item) => total + item.actionableCrossContextImports,
        0,
      ),
    ).toBe(0);
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
