import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../../src/modules/runtime/domain/release-manifest';

const image = 'alphaci-agent-e2e:1';
export function buildShellFixture() {
  execFileSync('docker', ['build', '-t', image, '-'], {
    input:
      'FROM alpine:3.20\nRUN apk add --no-cache bash jq openssl curl coreutils\n',
    stdio: ['pipe', 'ignore', 'inherit'],
  });
}
export function shellFixture() {
  const work = mkdtempSync(join(tmpdir(), 'alphaci-machine-test-'));
  for (const directory of [
    'bin',
    'host',
    'host/bin',
    'host/secrets',
    'host/assignments',
  ])
    mkdirSync(join(work, directory), { recursive: true });
  for (const [source, destination] of [
    ['alphaci-agent.sh', 'alphaci-agent'],
    ['render-assignment.sh', 'render-assignment'],
    ['alphaci-supervisor.sh', 'alphaci-supervisor'],
    ['enroll.sh', 'enroll'],
    ['tunnel.sh', 'tunnel.sh'],
  ])
    writeFileSync(
      join(work, 'host/bin', destination!),
      readFileSync(resolve('deploy/onprem/agent', source!), 'utf8').replace(
        /\r\n/g,
        '\n',
      ),
    );
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKey = key.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const token = 'onprem_machine_' + 'x'.repeat(43),
    code = 'y'.repeat(43);
  writeFileSync(
    join(work, 'receipt.json'),
    JSON.stringify({
      machine: { id: randomUUID() },
      credential: token,
      apiUrl: 'https://fixture.invalid',
      trustKeys: { test: publicKey },
    }),
  );
  writeFileSync(join(work, 'host/secrets/machine-token'), token);
  writeFileSync(
    join(work, 'host/trust.json'),
    JSON.stringify({ test: publicKey }),
  );
  writeFileSync(
    join(work, 'host/machine.json'),
    JSON.stringify({
      id: randomUUID(),
      apiUrl: 'https://fixture.invalid',
      agentVersion: 'test',
      tokenFile: '/work/host/secrets/machine-token',
      trustFile: '/work/host/trust.json',
    }),
  );
  writeFileSync(join(work, 'assignments.json'), '[]');
  writeFileSync(
    join(work, 'bin/ss'),
    '#!/bin/bash\n[ ! -f /work/occupied ] || echo LISTEN\n',
  );
  writeFileSync(
    join(work, 'bin/docker'),
    '#!/bin/bash\nexec 8>/work/docker-record.lock; flock 8; echo "$*" >> /work/docker.log; flock -u 8\nif [ "$1" = compose ] && [ -f /work/slow ]; then sleep 1; fi\n',
  );
  writeFileSync(
    join(work, 'bin/curl'),
    `#!/bin/bash
printf '%s\\n' "$@" >> /work/curl-arguments.log
url=""; output=""; data=""
while (($#)); do
 case "$1" in -o) output="$2"; shift;; --data-binary|-d) data="$2"; shift;; http*) url="$1";; esac
 shift
done
case "$url" in
 */enroll) test ! -f /work/fail-enroll || exit 22; cp /work/receipt.json "$output"; echo enroll >> /work/requests.log;;
 */heartbeat) test ! -f /work/revoked || exit 22; echo heartbeat >> /work/requests.log; case "$data" in @*) cp "\${data#@}" /work/heartbeat-body.json;; esac; if [ -f /work/heartbeat-reply.json ]; then cp /work/heartbeat-reply.json "\${output:-/dev/stdout}"; else echo '{"ports":[]}' > "\${output:-/dev/stdout}"; fi;;
 */assignments) cp /work/assignments.json "$output"; echo assignments >> /work/requests.log;;
 */status) case "$data" in @*) cat "\${data#@}" >> /work/statuses.log;; *) printf '%s' "$data" >> /work/statuses.log;; esac; printf '\\n' >> /work/statuses.log;;
esac
`,
  );
  // A stand-in for cloudflared: it records each start and stop, prints a quick
  // tunnel address unless /work/tunnel-silent exists, and runs until terminated.
  writeFileSync(
    join(work, 'bin/cloudflared'),
    `#!/bin/bash
echo "start $*" >> /work/cloudflared-calls.log
trap 'echo stop >> /work/cloudflared-calls.log; exit 0' TERM INT
[ -f /work/tunnel-silent ] || echo 'https://quiet-fox-blue-cloud.trycloudflare.com'
while :; do sleep 1; done
`,
  );
  function run(command: string, input = '') {
    return execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '-v',
        work + ':/work',
        image,
        'bash',
        '-c',
        'chmod +x /work/bin/* /work/host/bin/*; export PATH=/work/bin:$PATH ALPHACI_HOME=/work/host; ' +
          command,
      ],
      { encoding: 'utf8', input, timeout: 60_000 },
    );
  }
  function assignment(port = 18123, health: string | null = '/') {
    const projectId = randomUUID(),
      environmentId = randomUUID(),
      deploymentId = randomUUID();
    const manifest = {
      schemaVersion: 1,
      releaseId: randomUUID(),
      projectId,
      sourceEnvironmentId: environmentId,
      sourceBranch: 'dev',
      commitSha: 'a'.repeat(40),
      createdAt: new Date().toISOString(),
      artifacts: [
        {
          slot: 'frontend',
          image: 'ghcr.io/e2e/web',
          digest: 'sha256:' + 'a'.repeat(64),
        },
      ],
      workflowRun: {
        provider: 'github_actions',
        repo: 'e2e/web',
        runId: '1',
        url: 'https://github.com/e2e/web/actions/runs/1',
      },
    };
    const canonical = canonicalJson(manifest);
    return {
      deploymentId,
      assignment: {
        projectId,
        environmentId,
        machine: {
          id: randomUUID(),
          projectId,
          environmentId,
          config: {
            ports: [{ slot: 'frontend', hostPort: port, containerPort: 3000 }],
            health: [{ slot: 'frontend', path: health }],
            ingress: { mode: 'direct', publicUrl: null },
          },
        },
      },
      envelope: {
        manifest,
        manifestSha256: createHash('sha256').update(canonical).digest('hex'),
        signature: {
          algorithm: 'ecdsa-p256-sha256',
          keyId: 'test',
          value: sign(
            'sha256',
            Buffer.from(canonical),
            key.privateKey,
          ).toString('base64'),
        },
      },
    };
  }
  function resign(value: ReturnType<typeof assignment>) {
    const canonical = canonicalJson(value.envelope.manifest);
    value.envelope.manifestSha256 = createHash('sha256')
      .update(canonical)
      .digest('hex');
    value.envelope.signature.value = sign(
      'sha256',
      Buffer.from(canonical),
      key.privateKey,
    ).toString('base64');
    return value;
  }
  return { work, run, assignment, token, code, resign };
}
