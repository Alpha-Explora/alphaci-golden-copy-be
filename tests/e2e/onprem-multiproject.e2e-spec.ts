import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  returnWorkToHostUser,
  shellFixture,
} from './support/onprem-shell-fixture';

// Docker and HTTP health are real. The API recorder and host-network adapters
// below replace only the fixture's control server and container namespace.
describe('Two projects on one real Docker daemon', () => {
  const f = shellFixture(),
    suffix = randomUUID().slice(0, 8),
    registry = 'alphaci-registry-' + suffix;
  const projects: string[] = [];
  let registryPort: number;
  const docker = (args: string[]) =>
    execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000 }).trim();
  beforeAll(async () => {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    registryPort = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    docker([
      'run',
      '-d',
      '--name',
      registry,
      '-p',
      `127.0.0.1:${registryPort}:5000`,
      'registry:2',
    ]);
    execFileSync(
      'docker',
      ['build', '-t', 'alphaci-machine-live-test:1', '-'],
      {
        input:
          'FROM alpine:3.20\nRUN apk add --no-cache bash jq openssl curl coreutils docker-cli docker-cli-compose iproute2\n',
        stdio: ['pipe', 'ignore', 'inherit'],
        timeout: 180_000,
      },
    );
    rmSync(join(f.work, 'bin/docker'));
    const curl = readFileSync(join(f.work, 'bin/curl'), 'utf8');
    writeFileSync(
      join(f.work, 'bin/curl'),
      curl.replace(
        'case "$url" in',
        `case "$url" in
 http://127.0.0.1:*) exec /usr/bin/curl -fsS --max-time 2 --retry 3 --retry-delay 1 --retry-all-errors "\${url/127.0.0.1/host.docker.internal}";;`,
      ),
    );
  }, 240_000);
  afterAll(() => {
    for (const project of projects) {
      const ids = docker([
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=' + project,
      ]);
      if (ids) docker(['rm', '-f', ...ids.split(/\s+/)]);
      const volumes = docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        'label=com.docker.compose.project=' + project,
      ]);
      if (volumes) docker(['volume', 'rm', ...volumes.split(/\s+/)]);
      const networks = docker([
        'network',
        'ls',
        '-q',
        '--filter',
        'label=com.docker.compose.project=' + project,
      ]);
      if (networks) docker(['network', 'rm', ...networks.split(/\s+/)]);
    }
    docker(['rm', '-f', registry]);
  });
  function image(status: number) {
    const context = join(f.work, 'image-' + status);
    mkdirSync(context);
    writeFileSync(
      join(context, 'server.cjs'),
      `require('http').createServer((q,s)=>{s.statusCode=${status};s.end('app-${status}');}).listen(3000,'0.0.0.0');`,
    );
    writeFileSync(
      join(context, 'Dockerfile'),
      'FROM node:24-alpine\nCOPY server.cjs /server.cjs\nCMD ["node","/server.cjs"]\n',
    );
    const name = `localhost:${registryPort}/e2e/web:${status}`;
    docker(['build', '-t', name, context]);
    docker(['push', name]);
    return docker([
      'image',
      'inspect',
      name,
      '--format',
      '{{index .RepoDigests 0}}',
    ]).split('@')[1]!;
  }
  async function run(
    assignment: ReturnType<typeof f.assignment>,
    file: string,
  ) {
    writeFileSync(join(f.work, file), JSON.stringify(assignment));
    await promisify(execFile)(
      'docker',
      [
        'run',
        '--rm',
        '--add-host=host.docker.internal:host-gateway',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-v',
        f.work + ':/work',
        'alphaci-machine-live-test:1',
        'bash',
        '-c',
        returnWorkToHostUser(
          `chmod +x /work/bin/* /work/host/bin/*; export PATH=/work/bin:$PATH ALPHACI_HOME=/work/host; /work/host/bin/render-assignment /work/${file}`,
        ),
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
  }
  it('deploys A and B, rolls back A after a real HTTP failure, and preserves B container and data', async () => {
    const good = image(200),
      bad = image(503);
    const a = f.assignment(18271),
      b = f.assignment(18272);
    for (const item of [a, b]) {
      item.envelope.manifest.artifacts[0]!.image = `localhost:${registryPort}/e2e/web`;
      item.envelope.manifest.artifacts[0]!.digest = good;
      f.resign(item);
      projects.push('ac-' + item.assignment.environmentId.replaceAll('-', ''));
    }
    await Promise.all([run(a, 'a.json'), run(b, 'b.json')]);
    const bId = docker([
      'ps',
      '-q',
      '--filter',
      'label=com.docker.compose.project=' + projects[1],
    ]);
    expect(bId).not.toBe('');
    docker([
      'exec',
      bId,
      'sh',
      '-c',
      'printf preserved > /var/lib/alphaci-data/sentinel',
    ]);
    const bState = join(
      f.work,
      'host/assignments',
      b.assignment.projectId,
      b.assignment.environmentId,
      'releases/current.env',
    );
    const beforeB = readFileSync(bState, 'utf8');
    const update = JSON.parse(JSON.stringify(a)) as typeof a;
    update.deploymentId = randomUUID();
    update.envelope.manifest.releaseId = randomUUID();
    update.envelope.manifest.artifacts[0]!.digest = bad;
    f.resign(update);
    await run(update, 'a-update.json');
    expect(readFileSync(join(f.work, 'statuses.log'), 'utf8')).toContain(
      'rolled_back',
    );
    expect(
      docker([
        'ps',
        '-q',
        '--filter',
        'label=com.docker.compose.project=' + projects[1],
      ]),
    ).toBe(bId);
    expect(docker(['exec', bId, 'cat', '/var/lib/alphaci-data/sentinel'])).toBe(
      'preserved',
    );
    expect(readFileSync(bState, 'utf8')).toBe(beforeB);
    const aState = join(
      f.work,
      'host/assignments',
      a.assignment.projectId,
      a.assignment.environmentId,
      'releases/current.env',
    );
    expect(readFileSync(aState, 'utf8')).toContain(good);
    expect(readFileSync(aState, 'utf8')).not.toContain(bad);
    expect(await (await fetch('http://127.0.0.1:18271/')).text()).toBe(
      'app-200',
    );
    expect(await (await fetch('http://127.0.0.1:18272/')).text()).toBe(
      'app-200',
    );
  }, 240_000);
});
