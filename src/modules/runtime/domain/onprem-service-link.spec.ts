import {
  SERVICE_LINK_ENV_KEY,
  SERVICE_LINK_NETWORK,
  deriveServiceLink,
  serviceLinkNetwork,
  type ServiceLinkCandidate,
} from './onprem-service-link';

const BACKEND_ENV = '11111111-1111-4111-8111-111111111111';
const FRONTEND_ENV = '22222222-2222-4222-8222-222222222222';

function candidate(
  slot: 'frontend' | 'backend',
  overrides: Partial<ServiceLinkCandidate> = {},
): ServiceLinkCandidate {
  return {
    projectId: slot === 'backend' ? 'backend-project' : 'frontend-project',
    environmentId: slot === 'backend' ? BACKEND_ENV : FRONTEND_ENV,
    slug: 'dev',
    ports: [{ slot, containerPort: slot === 'backend' ? 4000 : 3000 }],
    publicAddress: null,
    ...overrides,
  };
}

describe('serviceLinkNetwork', () => {
  it('is deterministic per pair and environment, and valid for the agent', () => {
    const name = serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, 'dev');
    expect(name).toBe(serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, 'dev'));
    expect(name).toMatch(/^alphaci-[a-f0-9]{12}-dev$/);
    expect(name).toMatch(SERVICE_LINK_NETWORK);
    expect(serviceLinkNetwork(FRONTEND_ENV, BACKEND_ENV, 'dev')).not.toBe(name);
  });
  it('reduces any slug to safe characters', () => {
    for (const slug of [
      'UAT',
      'feature/x y',
      '--',
      '',
      'a'.repeat(80),
      '$(id)',
    ])
      expect(serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, slug)).toMatch(
        SERVICE_LINK_NETWORK,
      );
    expect(
      serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, 'feature/x y'),
    ).toMatch(/-feature-x-y$/);
    expect(serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, '--')).toMatch(
      /-env$/,
    );
  });
});

describe('deriveServiceLink', () => {
  const backend = candidate('backend', {
    publicAddress: null,
  });
  const frontend = candidate('frontend', {
    publicAddress: 'https://quiet-fox.trycloudflare.com/',
  });
  const network = serviceLinkNetwork(BACKEND_ENV, FRONTEND_ENV, 'dev');

  it('links the frontend to the backend on the same machine', () => {
    expect(deriveServiceLink(frontend, [backend, frontend])).toEqual({
      network,
      env: { frontend: { API_URL: 'http://backend:4000' } },
      peers: [{ environmentId: BACKEND_ENV, slot: 'backend' }],
    });
  });
  it('gives the backend the frontend address for redirects and CORS', () => {
    expect(deriveServiceLink(backend, [backend, frontend])).toEqual({
      network,
      env: {
        backend: {
          FRONTEND_URL: 'https://quiet-fox.trycloudflare.com',
          CORS_ORIGINS: 'https://quiet-fox.trycloudflare.com',
        },
      },
      peers: [{ environmentId: FRONTEND_ENV, slot: 'frontend' }],
    });
  });
  it('uses the backend container port, and the origin for CORS', () => {
    const custom = candidate('backend', {
      ports: [{ slot: 'backend', containerPort: 8080 }],
    });
    const configured = candidate('frontend', {
      publicAddress: 'https://app.example.com/portal',
    });
    expect(deriveServiceLink(configured, [custom, configured])?.env).toEqual({
      frontend: { API_URL: 'http://backend:8080' },
    });
    expect(deriveServiceLink(custom, [custom, configured])?.env).toEqual({
      backend: {
        FRONTEND_URL: 'https://app.example.com/portal',
        CORS_ORIGINS: 'https://app.example.com',
      },
    });
  });
  it('still links the backend, without variables, while the frontend address is unknown', () => {
    const link = deriveServiceLink(backend, [
      backend,
      candidate('frontend', { publicAddress: null }),
    ]);
    expect(link).toEqual({
      network,
      env: {},
      peers: [{ environmentId: FRONTEND_ENV, slot: 'frontend' }],
    });
  });
  it.each([
    'javascript:alert(1)',
    'https://user:secret@example.com',
    'https://example.com/\nX: y',
    'https://example.com/$HOME',
    'not a url',
  ])('never forwards an unsafe frontend address (%s)', (publicAddress) => {
    expect(
      deriveServiceLink(backend, [
        backend,
        candidate('frontend', { publicAddress }),
      ])?.env,
    ).toEqual({});
  });
  it('does not link when the other half is on another machine', () => {
    // The machine's bindings are the candidates: the backend is not among them.
    expect(deriveServiceLink(frontend, [frontend])).toBeNull();
  });
  it('does not link when one side is missing', () => {
    expect(deriveServiceLink(backend, [backend])).toBeNull();
  });
  it('does not link environments whose slugs differ', () => {
    const uat = candidate('backend', { slug: 'uat' });
    expect(deriveServiceLink(frontend, [uat, frontend])).toBeNull();
    expect(deriveServiceLink(uat, [uat, frontend])).toBeNull();
  });
  it('does not link a single app that runs both slots', () => {
    const both = candidate('frontend', {
      ports: [
        { slot: 'frontend', containerPort: 3000 },
        { slot: 'backend', containerPort: 4000 },
      ],
    });
    expect(deriveServiceLink(both, [both, backend])).toBeNull();
  });
  it('does not link when the pair is ambiguous', () => {
    const second = candidate('frontend', {
      projectId: 'second-frontend',
      environmentId: '33333333-3333-4333-8333-333333333333',
    });
    expect(deriveServiceLink(frontend, [backend, frontend, second])).toBeNull();
    expect(deriveServiceLink(backend, [backend, frontend, second])).toBeNull();
  });
  it('does not link two slots of the same project', () => {
    const sameProject = candidate('frontend', { projectId: 'backend-project' });
    expect(deriveServiceLink(sameProject, [backend, sameProject])).toBeNull();
  });
  it('emits only variable names the agent accepts', () => {
    for (const self of [frontend, backend]) {
      const link = deriveServiceLink(self, [backend, frontend])!;
      for (const env of Object.values(link.env))
        for (const key of Object.keys(env ?? {}))
          expect(key).toMatch(SERVICE_LINK_ENV_KEY);
    }
  });
});
