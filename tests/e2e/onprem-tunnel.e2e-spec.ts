import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildShellFixture,
  shellFixture,
} from './support/onprem-shell-fixture';

const quickAddress = 'https://quiet-fox-blue-cloud.trycloudflare.com';

type Fixture = ReturnType<typeof shellFixture>;
type Assignment = ReturnType<Fixture['assignment']>;

describe('Automatic HTTPS address (tunnel) with recording fixture', () => {
  beforeAll(buildShellFixture);
  /** The binding the heartbeat reply names for a tunnel-mode assignment. */
  function binding(f: Fixture, port: number) {
    const a = f.assignment(port);
    return {
      a,
      tunnel: {
        assignmentId: a.assignment.machine.id,
        projectId: a.assignment.projectId,
        environmentId: a.assignment.environmentId,
        hostPort: port,
      },
    };
  }
  const lines = (file: string) =>
    existsSync(file)
      ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      : [];
  const calls = (f: Fixture) => lines(join(f.work, 'cloudflared-calls.log'));
  const units = (f: Fixture) => lines(join(f.work, 'systemctl.log'));
  const stateFile = (f: Fixture, a: Assignment) =>
    join(f.work, 'host/tunnels', a.assignment.environmentId, 'tunnel.json');
  const pidFile = (f: Fixture, a: Assignment) =>
    join(f.work, 'units', `${a.assignment.environmentId}.pid`);
  function stateOf(f: Fixture, a: Assignment) {
    return JSON.parse(readFileSync(stateFile(f, a), 'utf8')) as Record<
      string,
      unknown
    >;
  }
  function startLine(a: Assignment, port: number) {
    return `start tunnel --config /work/host/tunnels/${a.assignment.environmentId}/config.yml --no-autoupdate --url http://127.0.0.1:${port}`;
  }
  it('keeps one tunnel per assignment and reports its address on the next check-in', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18150);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18150], tunnels: [tunnel] }),
    );
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1',
    );
    // systemd keeps one unit running; a later check-in does not start another.
    expect(units(f).filter((line) => line.startsWith('start '))).toHaveLength(
      1,
    );
    expect(calls(f)).toEqual([startLine(a, 18150)]);
    expect(stateOf(f, a)).toMatchObject({
      assignmentId: tunnel.assignmentId,
      status: 'running',
      publicUrl: quickAddress,
    });
    const body = JSON.parse(
      readFileSync(join(f.work, 'heartbeat-body.json'), 'utf8'),
    ) as { tunnels: Array<Record<string, unknown>> };
    expect(body.tunnels).toHaveLength(1);
    expect(body.tunnels[0]).toMatchObject({
      assignmentId: tunnel.assignmentId,
      status: 'running',
      publicUrl: quickAddress,
    });
    expect(body.tunnels[0]).not.toHaveProperty('port');
  });
  it('waits for the address while cloudflared has not printed one', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18151);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18151], tunnels: [tunnel] }),
    );
    writeFileSync(join(f.work, 'tunnel-silent'), '1');
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only',
    );
    expect(stateOf(f, a)).toMatchObject({
      status: 'starting',
      publicUrl: null,
      message: 'Waiting for Cloudflare to assign the automatic HTTPS address.',
    });
  });
  it('shows a missing cloudflared as a plain message and starts no unit', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18152);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18152], tunnels: [tunnel] }),
    );
    f.run(
      'ALPHACI_CLOUDFLARED=/work/none/cloudflared /work/host/bin/alphaci-supervisor --heartbeat-only',
    );
    const state = stateOf(f, a);
    expect(state).toMatchObject({ status: 'unavailable', publicUrl: null });
    expect(String(state['message'])).toContain('cloudflared is not installed');
    expect(calls(f)).toEqual([]);
    expect(units(f).some((line) => line.startsWith('start '))).toBe(false);
    // The rest of the machine still publishes its reserved port.
    expect(
      JSON.parse(
        readFileSync(join(f.work, 'host/published-ports.json'), 'utf8'),
      ),
    ).toEqual([18152]);
  });
  it('refuses a cloudflared older than the release AlphaCI was tested with', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18153);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18153], tunnels: [tunnel] }),
    );
    writeFileSync(join(f.work, 'cloudflared-old'), '1');
    f.run('/work/host/bin/alphaci-supervisor --heartbeat-only');
    expect(stateOf(f, a)).toMatchObject({ status: 'unavailable' });
    expect(String(stateOf(f, a)['message'])).toContain('older than 2026.10.0');
    expect(calls(f)).toEqual([]);
  });
  it('restarts a tunnel that stopped, and reports the stop on that check-in', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18154);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18154], tunnels: [tunnel] }),
    );
    f.run(
      `/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; kill $(cat /work/units/${a.assignment.environmentId}.pid); sleep 2; /work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1`,
    );
    expect(calls(f)).toEqual([
      startLine(a, 18154),
      'stop',
      startLine(a, 18154),
    ]);
    expect(stateOf(f, a)).toMatchObject({
      status: 'failed',
      message: 'The Cloudflare tunnel stopped. Starting it again.',
    });
  });
  it('ends the tunnel of an assignment that leaves the machine', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18155);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18155], tunnels: [tunnel] }),
    );
    writeFileSync(
      join(f.work, 'heartbeat-reply-empty.json'),
      JSON.stringify({ ports: [18155], tunnels: [] }),
    );
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; cp /work/heartbeat-reply-empty.json /work/heartbeat-reply.json; /work/host/bin/alphaci-supervisor --heartbeat-only; sleep 2',
    );
    expect(units(f)).toContain(
      `stop alphaci-tunnel@${a.assignment.environmentId}.service`,
    );
    expect(existsSync(stateFile(f, a))).toBe(false);
    expect(calls(f)).toContain('stop');
  });
  it('stops every tunnel when the machine credential is revoked', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18156);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18156], tunnels: [tunnel] }),
    );
    const output = f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; touch /work/revoked; /work/host/bin/alphaci-supervisor --heartbeat-only || echo REJECTED; sleep 2',
    );
    expect(output).toContain('REJECTED');
    expect(calls(f)).toContain('stop');
    expect(existsSync(stateFile(f, a))).toBe(false);
    expect(existsSync(pidFile(f, a))).toBe(false);
  });
  it('stops every tunnel on --stop-tunnels, which uninstall runs', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18157);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18157], tunnels: [tunnel] }),
    );
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --stop-tunnels; sleep 2',
    );
    expect(existsSync(stateFile(f, a))).toBe(false);
    expect(calls(f)).toContain('stop');
  });
  it('reports only a quick-tunnel address, never another host it printed', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18158);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18158], tunnels: [tunnel] }),
    );
    writeFileSync(
      join(f.work, 'tunnel-banner'),
      'https://api.trycloudflare.com',
    );
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only',
    );
    expect(stateOf(f, a)).toMatchObject({
      status: 'starting',
      publicUrl: null,
    });
    const body = readFileSync(join(f.work, 'heartbeat-body.json'), 'utf8');
    expect(body).not.toContain('api.trycloudflare.com');
  });
  it('reads the address from output that contains binary bytes', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18159);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18159], tunnels: [tunnel] }),
    );
    writeFileSync(join(f.work, 'tunnel-nul'), '1');
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only',
    );
    expect(stateOf(f, a)).toMatchObject({
      status: 'running',
      publicUrl: quickAddress,
    });
  });
  it('does not trust a record from an earlier run', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18160);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18160], tunnels: [tunnel] }),
    );
    // A record can say "running" after a reboot while nothing runs: systemd decides.
    const record = {
      assignmentId: tunnel.assignmentId,
      port: 18160,
      status: 'running',
      publicUrl: quickAddress,
      message: 'stale',
    };
    writeFileSync(join(f.work, 'stale-record.json'), JSON.stringify(record));
    f.run(
      `mkdir -p /work/host/tunnels/${a.assignment.environmentId} && cp /work/stale-record.json ${stateFile(f, a).replace(join(f.work), '/work')} && /work/host/bin/alphaci-supervisor --heartbeat-only`,
    );
    const state = stateOf(f, a);
    expect(state['status']).not.toBe('running');
    expect(state['publicUrl']).toBeNull();
  });
  it('starts no tunnel for direct or configured assignments', () => {
    const f = shellFixture();
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18161], tunnels: [] }),
    );
    f.run('/work/host/bin/alphaci-supervisor --heartbeat-only');
    expect(calls(f)).toEqual([]);
    expect(units(f).some((line) => line.startsWith('start '))).toBe(false);
  });
});
