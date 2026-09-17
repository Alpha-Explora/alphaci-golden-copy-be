import { RenderReleaseService } from './render-release.service';
import type { DeploymentTargetSummary } from '../../../core/deployments.types';

function target(
  overrides: Partial<DeploymentTargetSummary> = {},
): DeploymentTargetSummary {
  return {
    id: 'target-1',
    projectId: 'project-1',
    slot: 'backend',
    ownershipMode: 'flowci_managed',
    provider: 'render',
    providerConnectionId: null,
    providerProjectId: 'srv-abc',
    providerProjectName: 'demo-backend-uat',
    repoFullName: 'org/demo-be',
    branchName: 'uat',
    rootDirectory: null,
    buildCommand: null,
    startCommand: null,
    environmentMap: {},
    deploymentStrategy: 'render_image_pushed',
    providerMetadata: {
      renderServiceUrl: 'https://demo-uat.onrender.com',
      imageUrl: 'ghcr.io/org/alphaci-backend-uat-demo:uat',
    },
    status: 'active',
    ...overrides,
  } as DeploymentTargetSummary;
}

function service(): RenderReleaseService {
  return new RenderReleaseService({
    getOrThrow: () => ({
      envProvisioning: { flowciManaged: { renderToken: 'rnd_test' } },
    }),
  } as never);
}

function stubFetch(
  response: {
    ok?: boolean;
    status?: number;
    body?: unknown;
    text?: string;
  } = {},
) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 201,
    json: async () => response.body ?? { id: 'dep-1', status: 'created' },
    text: async () => response.text ?? '',
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('RenderReleaseService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('only handles managed image-backed Render targets', () => {
    const releaser = service();

    expect(releaser.supports(target())).toBe(true);
    expect(
      releaser.supports(target({ deploymentStrategy: 'render_git_connected' })),
    ).toBe(false);
    expect(releaser.supports(target({ ownershipMode: 'byo' }))).toBe(false);
    expect(releaser.supports(target({ provider: 'vercel' }))).toBe(false);
  });

  it('asks Render to deploy the tag the pipeline just pushed', async () => {
    const fetchMock = stubFetch();

    const handle = await service().start({
      target: target(),
      branch: 'uat',
      commitSha: 'abc1234',
      artifact: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.render.com/v1/services/srv-abc/deploys');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      imageUrl: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
    });
    expect(handle).toMatchObject({
      providerReleaseId: 'dep-1',
      status: 'pending',
      serviceUrl: 'https://demo-uat.onrender.com',
    });
  });

  it('refuses an artifact from a different image repository', async () => {
    // Render accepts another tag, never another image. Refusing here names the
    // disagreement; Render's own error would only say the image was invalid.
    stubFetch();

    await expect(
      service().start({
        target: target(),
        branch: 'uat',
        commitSha: 'abc1234',
        artifact: 'ghcr.io/org/some-other-image:sha-abc1234',
      }),
    ).rejects.toThrow(/only accepts a different tag of the same image/);
  });

  it('falls back to the image the service was created with', async () => {
    const fetchMock = stubFetch();

    await service().start({
      target: target(),
      branch: 'uat',
      commitSha: 'abc1234',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      imageUrl: 'ghcr.io/org/alphaci-backend-uat-demo:uat',
    });
  });

  it.each([
    ['live', 'live'],
    ['build_in_progress', 'in_progress'],
    ['queued', 'pending'],
    ['build_failed', 'failed'],
    ['canceled', 'failed'],
    // A status this build has never heard of is not success. Treating it as
    // still running ends the wait at the caller's timeout with the word Render
    // used, instead of reporting a deployment that never happened as live.
    ['some_new_render_status', 'in_progress'],
  ])('maps Render status %s to %s', async (renderStatus, expected) => {
    stubFetch({ body: { id: 'dep-2', status: renderStatus } });

    const handle = await service().check({
      target: target(),
      providerReleaseId: 'dep-2',
    });

    expect(handle.status).toBe(expected);
  });

  it('points at the Render log when a deploy fails', async () => {
    stubFetch({ body: { id: 'dep-3', status: 'build_failed' } });

    const handle = await service().check({
      target: target(),
      providerReleaseId: 'dep-3',
    });

    expect(handle.message).toMatch(/build_failed/);
    expect(handle.message).toMatch(/Events tab/);
  });

  it('reports what Render said when it refuses the deploy', async () => {
    stubFetch({ ok: false, status: 402, text: 'workspace over quota' });

    await expect(
      service().start({
        target: target(),
        branch: 'uat',
        commitSha: 'abc1234',
      }),
    ).rejects.toThrow(/HTTP 402.*workspace over quota/s);
  });

  it('refuses to release without a configured Render key', async () => {
    stubFetch();
    const releaser = new RenderReleaseService({
      getOrThrow: () => ({
        envProvisioning: { flowciManaged: { renderToken: '   ' } },
      }),
    } as never);

    await expect(
      releaser.start({ target: target(), branch: 'uat', commitSha: 'abc1234' }),
    ).rejects.toThrow(/ALPHACI_RENDER_API_KEY/);
  });
});
