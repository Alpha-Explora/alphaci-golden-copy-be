import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildShellFixture,
  shellFixture,
} from './support/onprem-shell-fixture';

type Fixture = ReturnType<typeof shellFixture>;
type Assignment = ReturnType<Fixture['assignment']>;
type Compose = {
  services: Record<
    string,
    {
      networks?: Record<string, { aliases?: string[] }>;
      environment?: Record<string, string>;
    }
  >;
  networks?: Record<string, { name: string; external: boolean }>;
};

const NETWORK = 'alphaci-0123456789ab-dev';

/** The agent applies an optional service link; these runs record Docker calls. */
describe('On-prem service link rendering with recording Docker fixture', () => {
  beforeAll(buildShellFixture);

  function linked(f: Fixture, link: unknown, port = 18140): Assignment {
    const value = f.assignment(port);
    (value.assignment as Record<string, unknown>)['link'] = link;
    return value;
  }
  function render(f: Fixture, value: Assignment) {
    writeFileSync(join(f.work, 'one.json'), JSON.stringify(value));
    try {
      f.run('/work/host/bin/render-assignment /work/one.json');
    } catch {
      // A blocked assignment exits non-zero after reporting; the files show why.
    }
    const directory = join(
      f.work,
      'host/assignments',
      value.assignment.projectId,
      value.assignment.environmentId,
    );
    const file = join(directory, 'compose.json');
    return {
      compose: existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Compose)
        : null,
      docker: existsSync(join(f.work, 'docker.log'))
        ? readFileSync(join(f.work, 'docker.log'), 'utf8')
        : '',
      statuses: existsSync(join(f.work, 'statuses.log'))
        ? readFileSync(join(f.work, 'statuses.log'), 'utf8')
        : '',
    };
  }

  it('renders exactly the previous Compose file when there is no link', () => {
    const f = shellFixture();
    const { compose, docker } = render(f, f.assignment(18141));
    expect(compose).toEqual({
      services: {
        frontend: {
          image: '${ALPHACI_IMAGE_FRONTEND}',
          restart: 'unless-stopped',
          ports: ['18141:3000'],
          volumes: ['frontend-data:/var/lib/alphaci-data'],
        },
      },
      volumes: { 'frontend-data': {} },
    });
    expect(docker).not.toContain('network');
  });

  it('joins the shared network under its slot alias and writes the runtime variables', () => {
    const f = shellFixture();
    const backendEnvironment = randomUUID();
    const { compose, docker, statuses } = render(
      f,
      linked(f, {
        network: NETWORK,
        env: {
          frontend: { API_URL: 'http://backend:4000', PRICE: 'costs $5 ${X}' },
        },
        peers: [{ environmentId: backendEnvironment, slot: 'backend' }],
      }),
    );
    expect(compose?.networks).toEqual({
      'alphaci-link': { name: NETWORK, external: true },
    });
    expect(compose?.services['frontend']?.networks).toEqual({
      default: {},
      'alphaci-link': { aliases: ['frontend'] },
    });
    // Compose would interpolate a bare dollar; the agent escapes it.
    expect(compose?.services['frontend']?.environment).toEqual({
      API_URL: 'http://backend:4000',
      PRICE: 'costs $$5 $${X}',
    });
    expect(docker).toContain(`network inspect ${NETWORK}`);
    expect(docker).toContain(
      `ps -q --filter label=com.docker.compose.project=ac-${backendEnvironment.replaceAll('-', '')} --filter label=com.docker.compose.service=backend`,
    );
    expect(statuses).toContain('healthy');
  });

  it('attaches the running other half to the network under its alias', () => {
    const f = shellFixture();
    const backendEnvironment = randomUUID();
    // The recording Docker answers `ps` for the peer's project with a container ID.
    writeFileSync(
      join(f.work, 'bin/docker'),
      `#!/bin/bash
exec 8>/work/docker-record.lock; flock 8; echo "$*" >> /work/docker.log; flock -u 8
case "$*" in *"ps -q --filter label=com.docker.compose.project=ac-${backendEnvironment.replaceAll('-', '')} "*) echo peer-container;; esac
`,
    );
    const { docker } = render(
      f,
      linked(f, {
        network: NETWORK,
        env: {},
        peers: [{ environmentId: backendEnvironment, slot: 'backend' }],
      }),
    );
    expect(docker).toContain(
      `network connect --alias backend ${NETWORK} peer-container`,
    );
  });

  it('links a backend without variables while the frontend address is unknown', () => {
    const f = shellFixture();
    const { compose } = render(
      f,
      linked(f, {
        network: NETWORK,
        env: {},
        peers: [{ environmentId: randomUUID(), slot: 'frontend' }],
      }),
    );
    expect(compose?.services['frontend']?.environment).toBeUndefined();
    expect(compose?.services['frontend']?.networks).toBeDefined();
  });

  it.each([
    ['a network outside the AlphaCI name space', { network: 'host' }],
    [
      'a network name with shell syntax',
      { network: 'alphaci-0123456789ab-$(id)' },
    ],
    [
      'a lower-case variable name',
      { network: NETWORK, env: { frontend: { api_url: 'x' } } },
    ],
    [
      'a variable name that would break the YAML key',
      { network: NETWORK, env: { frontend: { 'A: B\nC': 'x' } } },
    ],
    [
      'a value with a line break',
      { network: NETWORK, env: { frontend: { API_URL: 'x\nEVIL: 1' } } },
    ],
    [
      'a value with a carriage return',
      { network: NETWORK, env: { frontend: { API_URL: 'x\rEVIL' } } },
    ],
    [
      'a value with a NUL byte',
      { network: NETWORK, env: { frontend: { API_URL: 'x\u0000y' } } },
    ],
    [
      'a value that is not a string',
      { network: NETWORK, env: { frontend: { API_URL: { nested: true } } } },
    ],
    [
      'variables for a slot this environment does not run',
      { network: NETWORK, env: { backend: { FRONTEND_URL: 'https://x' } } },
    ],
    ['an unknown slot', { network: NETWORK, env: { worker: { A: 'b' } } }],
    [
      'a peer that is not an environment ID',
      {
        network: NETWORK,
        peers: [{ environmentId: '$(reboot)', slot: 'backend' }],
      },
    ],
    [
      'a peer with an unknown slot',
      {
        network: NETWORK,
        peers: [{ environmentId: randomUUID(), slot: 'db' }],
      },
    ],
    ['a link that is not an object', 'alphaci-0123456789ab-dev'],
  ])('refuses %s and deploys nothing', (_name, link) => {
    const f = shellFixture();
    const { compose, docker, statuses } = render(f, linked(f, link));
    expect(compose).toBeNull();
    expect(docker).not.toContain('compose');
    expect(docker).not.toContain('network');
    expect(statuses).toMatch(/"status": *"failed"/);
    expect(statuses).toContain('Nothing was deployed.');
  });
});
