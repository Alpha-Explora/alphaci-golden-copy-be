import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalJson } from '../../../src/modules/runtime/domain/release-manifest';

const image = 'alphaci-agent-e2e:2';
// Ubuntu, the agent's target OS: GNU coreutils buffer differently from Alpine's
// busybox, and the tunnel path depends on that.
export function buildShellFixture() {
  execFileSync('docker', ['build', '-t', image, '-'], {
    input:
      'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends bash jq openssl curl coreutils ca-certificates && rm -rf /var/lib/apt/lists/*\n',
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
    ['tunnel-run.sh', 'tunnel-run'],
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
 case "$1" in -o) output="$2"; shift;; -w) wfmt="$2"; shift;; --data-binary|-d) data="$2"; shift;; http*) url="$1";; esac
 shift
done
case "$url" in
 */enroll) if [ -f /work/fail-enroll ]; then test -z "$wfmt" || printf '000'; exit 6; fi; code=200; test ! -f /work/enroll-status || code=$(cat /work/enroll-status); if [ "$code" = 200 ]; then if [ -f /work/enroll-truncate ]; then head -c 40 /work/receipt.json > "$output"; else cp /work/receipt.json "$output"; fi; echo enroll >> /work/requests.log; fi; test -z "$wfmt" || printf '%s' "$code"; exit 0;;
 */heartbeat) case "$data" in @*) cp "\${data#@}" /work/heartbeat-body.json;; esac; if [ -f /work/revoked ]; then [ -z "$wfmt" ] || printf 401; exit 0; fi; echo heartbeat >> /work/requests.log; if [ -f /work/heartbeat-reply.json ]; then cp /work/heartbeat-reply.json "\${output:-/dev/stdout}"; else echo '{"ports":[]}' > "\${output:-/dev/stdout}"; fi; [ -z "$wfmt" ] || printf 200;;

 */assignments) cp /work/assignments.json "$output"; echo assignments >> /work/requests.log;;
 */status) case "$data" in @*) cat "\${data#@}" >> /work/statuses.log;; *) printf '%s' "$data" >> /work/statuses.log;; esac; printf '\\n' >> /work/statuses.log;;
esac
`,
  );
  // Stand-in for cloudflared. It reports its version (/work/cloudflared-old makes
  // it old), records each quick-tunnel start and stop, and ends on TERM. Its
  // output is the banner: NUL bytes around the address when /work/tunnel-nul
  // exists, nothing when /work/tunnel-silent exists. /work/tunnel-banner replaces
  // the address, and /work/tunnel-per-start gives every start its own address.
  writeFileSync(
    join(work, 'bin/cloudflared'),
    `#!/bin/bash
if [ "$1" = --version ]; then
  if [ -f /work/cloudflared-old ]; then echo 'cloudflared version 2025.1.0'; else echo 'cloudflared version 2026.10.0 (built 2026-10-05T08:39 UTC)'; fi
  exit 0
fi
echo "start $*" >> /work/cloudflared-calls.log
trap 'echo stop >> /work/cloudflared-calls.log; exit 0' TERM INT
address=https://quiet-fox-blue-cloud.trycloudflare.com
n=$(( $(cat /work/tunnel-starts 2>/dev/null || echo 0) + 1 ))
echo "$n" > /work/tunnel-starts
if [ -f /work/tunnel-per-start ]; then address=https://quiet-fox-blue-cloud-$n.trycloudflare.com; fi
[ ! -f /work/tunnel-banner ] || address=$(cat /work/tunnel-banner)
if [ -f /work/tunnel-once ] && [ "$n" -gt 1 ]; then
  :
elif [ -f /work/tunnel-nul ]; then
  printf junk; head -c 1 /dev/zero; echo "|  $address  |"
elif [ ! -f /work/tunnel-silent ]; then
  echo "|  $address  |"
fi
while :; do sleep 1; done
`,
  );
  // A stand-in for systemd's unit control: alphaci-tunnel@<id>.service starts
  // tunnel-run in the background with the unit's EnvironmentFile, and stop ends
  // it. Every call is recorded in systemctl.log.
  writeFileSync(
    join(work, 'bin/systemctl'),
    `#!/bin/bash
echo "$*" >> /work/systemctl.log
action=""; unit=""
for arg in "$@"; do
  case "$arg" in
    is-active|start|stop) action="$arg";;
    *.service) unit="$arg";;
  esac
done
id="\${unit#alphaci-tunnel@}"; id="\${id%.service}"
pidfile="/work/units/$id.pid"
mkdir -p /work/units
running() {
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile")
  [ -d "/proc/$pid" ] && [ "$(awk '/^State:/{print $2}' "/proc/$pid/status")" != Z ]
}
case "$action" in
  is-active) running ;;
  start)
    running || {
      set -a; . "/work/host/tunnels/$id/tunnel.env"; set +a
      nohup /work/host/bin/tunnel-run "$id" > "/work/units/$id.log" 2>&1 < /dev/null &
      echo $! > "$pidfile"
    } ;;
  stop)
    running && kill "$(cat "$pidfile")" 2> /dev/null
    rm -f "$pidfile" ;;
esac
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
