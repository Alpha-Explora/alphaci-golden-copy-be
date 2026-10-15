import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildShellFixture,
  shellFixture,
} from './support/onprem-shell-fixture';

describe('Machine supervisor with recording Docker fixture', () => {
  beforeAll(buildShellFixture);
  it('isolates two frontend-only assignments and takes one local lock per environment', () => {
    const f = shellFixture(),
      a = f.assignment(18120),
      b = f.assignment(18121);
    writeFileSync(join(f.work, 'assignments.json'), JSON.stringify([a, b]));
    f.run('/work/host/bin/alphaci-supervisor --once');
    for (const item of [a, b]) {
      const directory = join(
        f.work,
        'host/assignments',
        item.assignment.projectId,
        item.assignment.environmentId,
      );
      const compose = JSON.parse(
        readFileSync(join(directory, 'compose.json'), 'utf8'),
      ) as { services: Record<string, unknown> };
      expect(Object.keys(compose.services)).toEqual(['frontend']);
      expect(existsSync(join(directory, 'releases/current.env'))).toBe(true);
    }
    const before = readFileSync(join(f.work, 'docker.log'), 'utf8');
    expect(before).toContain(
      'ac-' + a.assignment.environmentId.replaceAll('-', ''),
    );
    expect(before).toContain(
      'ac-' + b.assignment.environmentId.replaceAll('-', ''),
    );
    writeFileSync(join(f.work, 'single.json'), JSON.stringify(a));
    writeFileSync(join(f.work, 'slow'), '1');
    writeFileSync(join(f.work, 'docker.log'), '');
    f.run(
      '/work/host/bin/render-assignment /work/single.json & /work/host/bin/render-assignment /work/single.json & wait',
    );
    expect(
      readFileSync(join(f.work, 'docker.log'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('compose ')),
    ).toHaveLength(1);
    writeFileSync(join(f.work, 'assignments.json'), '[]');
    writeFileSync(join(f.work, 'docker.log'), '');
    f.run('/work/host/bin/alphaci-supervisor --once');
    expect(readFileSync(join(f.work, 'docker.log'), 'utf8')).not.toContain(
      'compose -p',
    );
  });
  it('reports missing health and occupied ports as failed without pulling or changing a stack', () => {
    for (const missingHealth of [true, false]) {
      const f = shellFixture(),
        a = f.assignment(18122, missingHealth ? null : '/');
      writeFileSync(join(f.work, 'single.json'), JSON.stringify(a));
      if (!missingHealth) writeFileSync(join(f.work, 'occupied'), '1');
      expect(() =>
        f.run('/work/host/bin/render-assignment /work/single.json'),
      ).toThrow();
      expect(readFileSync(join(f.work, 'statuses.log'), 'utf8')).toContain(
        '"status": "failed"',
      );
      const calls = existsSync(join(f.work, 'docker.log'))
        ? readFileSync(join(f.work, 'docker.log'), 'utf8')
        : '';
      expect(calls).not.toContain('pull ');
      expect(calls).not.toContain('compose ');
    }
  });
  it('does not fetch or execute assignments after a revoked heartbeat', () => {
    const f = shellFixture();
    writeFileSync(
      join(f.work, 'assignments.json'),
      JSON.stringify([f.assignment()]),
    );
    writeFileSync(join(f.work, 'revoked'), '1');
    expect(() => f.run('/work/host/bin/alphaci-supervisor --once')).toThrow();
    expect(existsSync(join(f.work, 'requests.log'))).toBe(false);
    expect(existsSync(join(f.work, 'docker.log'))).toBe(true);
    expect(readFileSync(join(f.work, 'docker.log'), 'utf8')).not.toContain(
      'compose -p',
    );
  });
});
