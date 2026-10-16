import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildShellFixture,
  shellFixture,
} from './support/onprem-shell-fixture';

const quickAddress = 'https://quiet-fox-blue-cloud.trycloudflare.com';

describe('Automatic HTTPS address (tunnel) with recording fixture', () => {
  beforeAll(buildShellFixture);
  /** The binding the heartbeat reply names for a tunnel-mode assignment. */
  function binding(f: ReturnType<typeof shellFixture>, port: number) {
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
  function stateOf(
    f: ReturnType<typeof shellFixture>,
    a: ReturnType<ReturnType<typeof shellFixture>['assignment']>,
  ) {
    return JSON.parse(
      readFileSync(
        join(
          f.work,
          'host/assignments',
          a.assignment.projectId,
          a.assignment.environmentId,
          'tunnel.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
  }
  const calls = (f: ReturnType<typeof shellFixture>) =>
    existsSync(join(f.work, 'cloudflared-calls.log'))
      ? readFileSync(join(f.work, 'cloudflared-calls.log'), 'utf8')
          .trim()
          .split('\n')
      : [];
  it('keeps one tunnel per assignment and reports its address on the next check-in', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18150);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18150], tunnels: [tunnel] }),
    );
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only',
    );
    // One process serves the port for every check-in; it is not restarted.
    expect(calls(f)).toEqual([
      'start tunnel --no-autoupdate --url http://127.0.0.1:18150',
    ]);
    const state = stateOf(f, a);
    expect(state).toMatchObject({
      assignmentId: tunnel.assignmentId,
      status: 'running',
      publicUrl: quickAddress,
    });
    expect(typeof state.pid).toBe('number');
    // The last heartbeat carries the address the previous check observed.
    const body = JSON.parse(
      readFileSync(join(f.work, 'heartbeat-body.json'), 'utf8'),
    ) as { tunnels: Array<Record<string, unknown>> };
    expect(body.tunnels).toHaveLength(1);
    expect(body.tunnels[0]).toMatchObject({
      assignmentId: tunnel.assignmentId,
      status: 'running',
      publicUrl: quickAddress,
    });
    expect(body.tunnels[0]).not.toHaveProperty('pid');
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
  it('shows a missing cloudflared as a plain message and keeps the rest of the machine working', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18152);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18152], tunnels: [tunnel] }),
    );
    // The fixture's reserved port still reaches the heartbeat, so the machine
    // publishes it even though no tunnel can start.
    f.run(
      'ALPHACI_CLOUDFLARED=/work/none/cloudflared /work/host/bin/alphaci-supervisor --heartbeat-only',
    );
    const state = stateOf(f, a);
    expect(state).toMatchObject({
      status: 'unavailable',
      publicUrl: null,
      pid: null,
    });
    expect(String(state['message'])).toContain('cloudflared is not installed');
    expect(calls(f)).toEqual([]);
    const published = JSON.parse(
      readFileSync(join(f.work, 'host/published-ports.json'), 'utf8'),
    ) as number[];
    expect(published).toEqual([18152]);
  });
  it('restarts a tunnel that stopped and reports the stop on that check-in', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18153);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18153], tunnels: [tunnel] }),
    );
    const state =
      '/work/host/assignments/' +
      a.assignment.projectId +
      '/' +
      a.assignment.environmentId +
      '/tunnel.json';
    f.run(
      `/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; kill $(jq -r .pid ${state}); sleep 1; /work/host/bin/alphaci-supervisor --heartbeat-only`,
    );
    expect(stateOf(f, a)).toMatchObject({
      status: 'failed',
      message: 'The Cloudflare tunnel stopped. Starting it again.',
    });
    expect(calls(f)).toEqual([
      'start tunnel --no-autoupdate --url http://127.0.0.1:18153',
      'stop',
      'start tunnel --no-autoupdate --url http://127.0.0.1:18153',
    ]);
  });
  it('ends the tunnel of an assignment that leaves the machine', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18154);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18154], tunnels: [tunnel] }),
    );
    writeFileSync(
      join(f.work, 'heartbeat-reply-empty.json'),
      JSON.stringify({ ports: [18154], tunnels: [] }),
    );
    f.run(
      '/work/host/bin/alphaci-supervisor --heartbeat-only; sleep 1; cp /work/heartbeat-reply-empty.json /work/heartbeat-reply.json; /work/host/bin/alphaci-supervisor --heartbeat-only; sleep 2',
    );
    expect(
      existsSync(
        join(
          f.work,
          'host/assignments',
          a.assignment.projectId,
          a.assignment.environmentId,
          'tunnel.json',
        ),
      ),
    ).toBe(false);
    expect(calls(f)).toContain('stop');
  });
  it('never signals or trusts a process that merely reused a recorded PID', () => {
    const f = shellFixture();
    const { a, tunnel } = binding(f, 18156);
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18156], tunnels: [tunnel] }),
    );
    const state =
      '/work/host/assignments/' +
      a.assignment.projectId +
      '/' +
      a.assignment.environmentId +
      '/tunnel.json';
    // tunnel.json survives a reboot, when the recorded PID can belong to anything.
    const output = f.run(
      `sleep 300 & unrelated=$!; mkdir -p "$(dirname ${state})"; printf '{"assignmentId":"%s","port":18156,"pid":%s,"status":"running","publicUrl":null,"message":"stale"}' "${tunnel.assignmentId}" "$unrelated" > "${state}"; /work/host/bin/alphaci-supervisor --heartbeat-only; kill -0 "$unrelated" && echo UNRELATED_ALIVE`,
    );
    expect(output).toContain('UNRELATED_ALIVE');
    expect(calls(f)).toEqual([
      'start tunnel --no-autoupdate --url http://127.0.0.1:18156',
    ]);
    expect(stateOf(f, a)).toMatchObject({ status: 'failed' });
  });
  it('starts no tunnel for direct or configured assignments', () => {
    const f = shellFixture();
    writeFileSync(
      join(f.work, 'heartbeat-reply.json'),
      JSON.stringify({ ports: [18155], tunnels: [] }),
    );
    f.run('/work/host/bin/alphaci-supervisor --heartbeat-only');
    expect(calls(f)).toEqual([]);
  });
});
