import { BadGatewayException, BadRequestException } from '@nestjs/common';
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
      bootstrapImage: 'docker.io/library/nginx:alpine',
    },
    status: 'active',
    ...overrides,
  } as DeploymentTargetSummary;
}

function service(registryCredentialId?: string): RenderReleaseService {
  return new RenderReleaseService({
    getOrThrow: () => ({
      envProvisioning: {
        flowciManaged: {
          renderToken: 'rnd_test',
          ...(registryCredentialId
            ? { renderRegistryCredentialId: registryCredentialId }
            : {}),
        },
      },
    }),
  } as never);
}

const GHCR_IMAGE = 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234';

function bootstrapTarget(
  metadata: Record<string, unknown> = {},
): DeploymentTargetSummary {
  return target({
    providerMetadata: {
      renderServiceUrl: 'https://demo-uat.onrender.com',
      imageUrl: 'docker.io/library/nginx:alpine',
      bootstrapImage: 'docker.io/library/nginx:alpine',
      ...metadata,
    },
  });
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

  it('asks Render to deploy the tag the pipeline just pushed without PATCH when repository matches', async () => {
    const fetchMock = stubFetch();

    const handle = await service().start({
      target: target(),
      branch: 'uat',
      commitSha: 'abc1234',
      artifact: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('patches the service image when transitioning from bootstrap or a different repository', async () => {
    const fetchMock = stubFetch();

    const bootstrapTarget = target({
      providerMetadata: {
        renderServiceUrl: 'https://demo-uat.onrender.com',
        imageUrl: 'docker.io/library/nginx:alpine',
        bootstrapImage: 'docker.io/library/nginx:alpine',
      },
    });

    const handle = await service().start({
      target: bootstrapTarget,
      branch: 'uat',
      commitSha: 'abc1234',
      artifact: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Call 1: PATCH service image
    const [patchUrl, patchInit] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(patchUrl).toBe('https://api.render.com/v1/services/srv-abc');
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(String(patchInit.body))).toEqual({
      image: {
        imagePath: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
      },
    });
    // The patch changed what the service runs, so the caller is told to keep it.
    expect(handle.providerMetadataUpdates).toEqual({
      imageUrl: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
    });

    // Call 2: POST deploy
    const [deployUrl, deployInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(deployUrl).toBe(
      'https://api.render.com/v1/services/srv-abc/deploys',
    );
    expect(deployInit.method).toBe('POST');
    expect(JSON.parse(String(deployInit.body))).toEqual({
      imageUrl: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
    });

    expect(handle.providerReleaseId).toBe('dep-1');
  });

  describe('patching the image of a private registry', () => {
    async function patchBody(
      releaser: RenderReleaseService,
      t: DeploymentTargetSummary,
      artifact = GHCR_IMAGE,
    ) {
      const fetchMock = stubFetch();
      await releaser.start({
        target: t,
        branch: 'uat',
        commitSha: 'abc1234',
        artifact,
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('PATCH');
      expect(url).toBe('https://api.render.com/v1/services/srv-abc');
      return JSON.parse(String(init.body)) as {
        image: Record<string, unknown>;
      };
    }

    it('sends the credential and owner recorded on the target', async () => {
      const body = await patchBody(
        service('rcr-configured'),
        bootstrapTarget({
          renderRegistryCredentialId: 'rcr-recorded',
          renderOwnerId: 'tea-123',
        }),
      );

      expect(body).toEqual({
        image: {
          ownerId: 'tea-123',
          imagePath: GHCR_IMAGE,
          registryCredentialId: 'rcr-recorded',
        },
      });
    });

    it('falls back to the configured credential when the target recorded none', async () => {
      const body = await patchBody(
        service('rcr-configured'),
        bootstrapTarget(),
      );

      expect(body.image).toEqual({
        imagePath: GHCR_IMAGE,
        registryCredentialId: 'rcr-configured',
      });
    });

    it('sends no credential when none is known', async () => {
      const body = await patchBody(service(), bootstrapTarget());

      expect(body.image).toEqual({ imagePath: GHCR_IMAGE });
      expect(body.image).not.toHaveProperty('registryCredentialId');
    });

    it('treats a blank recorded credential as unknown', async () => {
      const body = await patchBody(
        service(),
        bootstrapTarget({ renderRegistryCredentialId: '   ' }),
      );

      expect(body.image).not.toHaveProperty('registryCredentialId');
    });

    it('keeps the credential for a docker.io image, as the create call does', async () => {
      const body = await patchBody(
        service('rcr-configured'),
        bootstrapTarget({ renderRegistryCredentialId: 'rcr-recorded' }),
        'docker.io/library/redis:7',
      );

      expect(body.image).toEqual({
        imagePath: 'docker.io/library/redis:7',
        registryCredentialId: 'rcr-recorded',
      });
    });
  });

  it('skips the patch once the image is already on the target repository', async () => {
    // What the caller persisted after the first release: the pipeline image.
    const fetchMock = stubFetch();

    const handle = await service('rcr-configured').start({
      target: target({
        providerMetadata: {
          renderServiceUrl: 'https://demo-uat.onrender.com',
          imageUrl: 'ghcr.io/org/alphaci-backend-uat-demo:sha-abc1234',
          bootstrapImage: 'docker.io/library/nginx:alpine',
        },
      }),
      branch: 'uat',
      commitSha: 'def5678',
      artifact: 'ghcr.io/org/alphaci-backend-uat-demo:sha-def5678',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe(
      'POST',
    );
    expect(handle.providerMetadataUpdates).toBeUndefined();
  });

  it('does not edit the target it was given', async () => {
    stubFetch();
    const t = bootstrapTarget();

    await service().start({
      target: t,
      branch: 'uat',
      commitSha: 'abc1234',
      artifact: GHCR_IMAGE,
    });

    expect(t.providerMetadata['imageUrl']).toBe(
      'docker.io/library/nginx:alpine',
    );
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

  it('reports what Render said when it refuses the deploy with BadGatewayException', async () => {
    stubFetch({ ok: false, status: 402, text: 'workspace over quota' });

    const promise = service().start({
      target: target(),
      branch: 'uat',
      commitSha: 'abc1234',
    });

    await expect(promise).rejects.toThrow(BadGatewayException);
    await expect(promise).rejects.toThrow(/HTTP 402.*workspace over quota/s);
  });

  it("carries Render's own sentence, not the JSON envelope, when the image patch is refused", async () => {
    stubFetch({
      ok: false,
      status: 400,
      text: '{"message":"unable to fetch image with provided input"}',
    });

    const promise = service().start({
      target: bootstrapTarget(),
      branch: 'uat',
      commitSha: 'abc1234',
      artifact: GHCR_IMAGE,
    });

    await expect(promise).rejects.toThrow(BadGatewayException);
    await expect(promise).rejects.toThrow(
      /^Render refused to update the service image \(HTTP 400\): unable to fetch image with provided input\./,
    );
    await expect(promise).rejects.toThrow(/read:packages/);
  });

  it('does not call the deploy endpoint after a refused image patch', async () => {
    const fetchMock = stubFetch({ ok: false, status: 400, text: 'nope' });

    await expect(
      service().start({
        target: bootstrapTarget(),
        branch: 'uat',
        commitSha: 'abc1234',
        artifact: GHCR_IMAGE,
      }),
    ).rejects.toThrow(BadGatewayException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('masks credential-shaped text in what Render said', async () => {
    stubFetch({
      ok: false,
      status: 401,
      text: '{"message":"denied for Bearer abc.def and ghp_SECRET123 via rnd_KEY9"}',
    });

    const promise = service().check({
      target: target(),
      providerReleaseId: 'dep-1',
    });

    await expect(promise).rejects.toThrow(/denied for Bearer \[redacted\]/);
    await expect(promise).rejects.not.toThrow(/SECRET123|rnd_KEY9|abc\.def/);
  });

  it('throws BadRequestException without a configured Render key', async () => {
    stubFetch();
    const releaser = new RenderReleaseService({
      getOrThrow: () => ({
        envProvisioning: { flowciManaged: { renderToken: '   ' } },
      }),
    } as never);

    const promise = releaser.start({
      target: target(),
      branch: 'uat',
      commitSha: 'abc1234',
    });

    await expect(promise).rejects.toThrow(BadRequestException);
    await expect(promise).rejects.toThrow(/ALPHACI_RENDER_API_KEY/);
  });

  it('throws BadRequestException when target has no service ID', async () => {
    stubFetch();

    const promise = service().start({
      target: target({ providerProjectId: '' }),
      branch: 'uat',
      commitSha: 'abc1234',
    });

    await expect(promise).rejects.toThrow(BadRequestException);
    await expect(promise).rejects.toThrow(/no Render service ID/);
  });
});
