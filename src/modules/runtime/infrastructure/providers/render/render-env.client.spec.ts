import { ProviderRateLimitedError } from '../../../core/provider-rate-limited.error';
import { RenderEnvClient } from './render-env.client';

function jsonResponse(json: unknown) {
  return { ok: true, json: () => Promise.resolve(json) };
}

describe('RenderEnvClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns owner metadata when validating Render connections', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            owner: {
              id: 'usr-owner-1',
              name: 'ALPHACI Test',
            },
          },
        ]),
    });

    const account = await new RenderEnvClient().validateConnection('rnd_test');

    expect(account).toEqual({
      id: 'usr-owner-1',
      name: 'ALPHACI Test',
      metadata: {
        ownerId: 'usr-owner-1',
        ownerName: 'ALPHACI Test',
      },
    });
  });

  it('uses fallback owner metadata when Render validation response is sparse', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await expect(
      new RenderEnvClient().validateConnection('rnd_test'),
    ).resolves.toEqual({
      id: 'render-account',
      name: 'Render account',
      metadata: {
        ownerId: 'render-account',
        ownerName: 'Render account',
      },
    });
  });

  it('lists Render service targets and filters incomplete rows', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          { service: { id: 'srv-1', name: 'orders-api' } },
          { service: { id: 'srv-2' } },
          {},
        ]),
    });

    await expect(new RenderEnvClient().listTargets('rnd')).resolves.toEqual([
      {
        id: 'srv-1',
        name: 'orders-api',
        provider: 'render',
      },
    ]);
  });

  it('merges env vars before Render replace update', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { envVar: { key: 'EXISTING', value: 'keep' } },
            { envVar: { key: 'DATABASE_URL', value: 'old' } },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

    const client = new RenderEnvClient();
    await client.upsertEnvironmentVariables({
      token: 'rnd',
      targetId: 'srv-1',
      lane: 'preview',
      gitBranch: 'feat/x',
      vars: [{ key: 'DATABASE_URL', value: 'new' }],
    });

    expect(fetch).toHaveBeenLastCalledWith(
      'https://api.render.com/v1/services/srv-1/env-vars',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify([
          { key: 'EXISTING', value: 'keep' },
          { key: 'DATABASE_URL', value: 'new' },
        ]),
      }),
    );
  });

  it('deletes Render env vars by replacing the set without the key', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { envVar: { key: 'EXISTING', value: 'keep' } },
            { envVar: { key: 'DATABASE_URL', value: 'remove' } },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

    const client = new RenderEnvClient();
    await expect(
      client.deleteEnvironmentVariable({
        token: 'rnd',
        targetId: 'srv-1',
        lane: 'preview',
        gitBranch: 'feat/x',
        key: 'DATABASE_URL',
      }),
    ).resolves.toEqual({ key: 'DATABASE_URL', status: 'removed' });

    expect(fetch).toHaveBeenLastCalledWith(
      'https://api.render.com/v1/services/srv-1/env-vars',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify([{ key: 'EXISTING', value: 'keep' }]),
      }),
    );
  });

  it('creates Render web services from repo metadata', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            owner: {
              id: 'tea-1',
              name: 'ALPHACI workspace',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-1', name: 'api-service' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-1', name: 'dev' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          service: {
            id: 'srv-1',
            name: 'api-service-dev',
          },
        }),
      );

    const client = new RenderEnvClient();
    const target = await client.createTarget({
      token: 'rnd',
      repoFullName: 'owner/api-service',
      projectName: 'api-service-dev',
      branchName: 'dev',
      rootDirectory: '.',
      buildCommand: 'npm ci && npm run build',
      startCommand: 'npm run start:prod',
    });

    expect(target).toMatchObject({
      id: 'srv-1',
      name: 'api-service-dev',
      provider: 'render',
      metadata: {
        deploymentStrategy: 'render_git_connected',
        renderServiceId: 'srv-1',
        renderServiceType: 'web_service',
        renderEnvironmentName: 'dev',
        renderEnvironmentId: 'env-1',
        renderProjectName: 'api-service',
        dockerContext: '.',
        dockerfilePath: 'Dockerfile',
      },
    });
    const [, request] = (fetch as jest.Mock).mock.calls[3] as [
      string,
      { body: string; method: string },
    ];
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({
      type: 'web_service',
      name: 'api-service-dev',
      ownerId: 'tea-1',
      environmentId: 'env-1',
      repo: 'https://github.com/owner/api-service',
      branch: 'dev',
      rootDir: '.',
      buildCommand: 'npm ci && npm run build',
      startCommand: 'npm run start:prod',
      serviceDetails: {
        runtime: 'node',
        buildCommand: 'npm ci && npm run build',
        startCommand: 'npm run start:prod',
      },
    });
  });

  it('uses the selected native Render runtime when creating Git-backed services', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            owner: {
              id: 'tea-1',
              name: 'ALPHACI workspace',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-2', name: 'worker' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-2', name: 'dev' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          service: {
            id: 'srv-python',
            name: 'worker-test',
          },
        }),
      );

    const client = new RenderEnvClient();
    const target = await client.createTarget({
      token: 'rnd',
      repoFullName: 'owner/worker',
      projectName: 'worker-test',
      branchName: 'dev',
      rootDirectory: '.',
      buildCommand: 'pip install -r requirements.txt',
      startCommand: 'python app.py',
      renderRuntime: 'python',
    });

    expect(target.metadata).toMatchObject({
      renderRuntime: 'python',
      renderEnvironmentId: 'env-2',
      renderProjectName: 'worker',
    });
    const [, request] = (fetch as jest.Mock).mock.calls[3] as [
      string,
      { body: string; method: string },
    ];
    expect(JSON.parse(request.body)).toMatchObject({
      environmentId: 'env-2',
      serviceDetails: {
        runtime: 'python',
        buildCommand: 'pip install -r requirements.txt',
        startCommand: 'python app.py',
      },
    });
  });

  it('creates native Dockerfile-backed Render services without build or start commands', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            owner: {
              id: 'tea-1',
              name: 'ALPHACI workspace',
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-3', name: 'api' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-3', name: 'dev' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          service: {
            id: 'srv-docker',
            name: 'api-docker-test',
          },
        }),
      );

    await new RenderEnvClient().createTarget({
      token: 'rnd',
      repoFullName: 'owner/api',
      projectName: 'api-docker-test',
      branchName: 'dev',
      rootDirectory: 'backend',
      buildCommand: 'npm ci && npm run build',
      startCommand: 'npm run start:prod',
      renderRuntime: 'docker',
    });

    const [, request] = (fetch as jest.Mock).mock.calls[3] as [
      string,
      { body: string; method: string },
    ];
    const body = JSON.parse(request.body) as {
      buildCommand?: string;
      startCommand?: string;
      environmentId?: string;
      serviceDetails: {
        runtime: string;
        buildCommand?: string;
        startCommand?: string;
      };
    };
    expect(body.buildCommand).toBeUndefined();
    expect(body.startCommand).toBeUndefined();
    expect(body.environmentId).toBe('env-3');
    expect(body.serviceDetails).toEqual({ runtime: 'docker' });
  });

  it('creates image-backed Render services with the bootstrap image', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-4', name: 'api-service' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-4', name: 'dev' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          service: {
            id: 'srv-image',
            name: 'api-service-dev',
          },
        }),
      );
    global.fetch = fetchMock;

    const configService = {
      getOrThrow: jest.fn().mockReturnValue({
        envProvisioning: {
          flowciManaged: {
            renderOwnerId: 'tea-configured',
            renderBootstrapImage: 'ghcr.io/flowci/bootstrap:node-22',
            renderRegistryCredentialId: 'crd-1',
          },
        },
      }),
    };
    const client = new RenderEnvClient(configService as never);

    const target = await client.createTarget({
      token: 'rnd',
      repoFullName: 'owner/api-service',
      projectName: 'api-service-dev',
      branchName: 'dev',
      deploymentStrategy: 'render_image_pushed',
      renderInstanceType: 'free',
      renderRegion: 'singapore',
    });

    expect(target.metadata).toMatchObject({
      deploymentStrategy: 'render_image_pushed',
      bootstrapImage: 'ghcr.io/flowci/bootstrap:node-22',
      imageUrl: 'ghcr.io/flowci/bootstrap:node-22',
      renderInstanceType: 'free',
      renderRegion: 'singapore',
      renderEnvironmentId: 'env-4',
      renderProjectName: 'api-service',
    });
    const [, request] = fetchMock.mock.calls[2] as [string, { body: string }];
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'web_service',
      name: 'api-service-dev',
      ownerId: 'tea-configured',
      environmentId: 'env-4',
      autoDeploy: 'no',
      image: {
        ownerId: 'tea-configured',
        imagePath: 'ghcr.io/flowci/bootstrap:node-22',
        registryCredentialId: 'crd-1',
      },
      serviceDetails: {
        runtime: 'image',
        plan: 'free',
        region: 'singapore',
      },
    });
    expect(body).not.toHaveProperty('repo');
    expect(body).not.toHaveProperty('branch');
    expect(body).not.toHaveProperty('rootDir');
  });

  it('uses configured ALPHACI Render owner id when creating services', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-5', name: 'api-service' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-5', name: 'dev' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          service: {
            id: 'srv-1',
            name: 'api-service-dev',
          },
        }),
      );
    global.fetch = fetchMock;

    const configService = {
      getOrThrow: jest.fn().mockReturnValue({
        envProvisioning: {
          flowciManaged: {
            renderOwnerId: 'tea-configured',
          },
        },
      }),
    };
    const client = new RenderEnvClient(configService as never);

    await client.createTarget({
      token: 'rnd',
      repoFullName: 'owner/api-service',
      projectName: 'api-service-dev',
      branchName: 'dev',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, request] = fetchMock.mock.calls[2] as [
      string,
      { body: string; method: string },
    ];
    const body = JSON.parse(request.body) as {
      ownerId: string;
      environmentId: string;
    };
    expect(url).toBe('https://api.render.com/v1/services');
    expect(request.method).toBe('POST');
    expect(body.ownerId).toBe('tea-configured');
    expect(body.environmentId).toBe('env-5');
  });

  it('throws when Render owner lookup returns no owner id', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{}]),
    });

    await expect(
      new RenderEnvClient().createTarget({
        token: 'rnd',
        repoFullName: 'owner/api-service',
        projectName: 'api-service-dev',
        branchName: 'dev',
      }),
    ).rejects.toThrow('Render workspace lookup returned no owner id');
  });

  it('throws when Render service creation returns an invalid response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ owner: { id: 'tea-1' } }]))
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-6', name: 'api-service' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-6', name: 'production' } }]),
      )
      .mockResolvedValueOnce(jsonResponse({ service: {} }));

    await expect(
      new RenderEnvClient().createTarget({
        token: 'rnd',
        repoFullName: 'owner/api-service',
        projectName: 'api-service-dev',
        branchName: 'main',
      }),
    ).rejects.toThrow('Render service creation returned an invalid response');
  });

  it.each([
    [
      'nested service id/name/url',
      {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested.onrender.com',
      },
    ],
    [
      'flat id/name/url',
      {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
      },
      {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
      },
    ],
  ])('maps a %s createTarget payload', async (_label, payload, expected) => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ owner: { id: 'tea-1' } }]))
      .mockResolvedValueOnce(
        jsonResponse([{ project: { id: 'prj-shapes', name: 'api-service' } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ environment: { id: 'env-shapes', name: 'dev' } }]),
      )
      .mockResolvedValueOnce(jsonResponse(payload));

    await expect(
      new RenderEnvClient().createTarget({
        token: 'rnd',
        repoFullName: 'owner/api-service',
        projectName: 'api-service-dev',
        branchName: 'dev',
      }),
    ).resolves.toMatchObject({
      id: expected.id,
      name: expected.name,
      metadata: { renderServiceUrl: expected.url },
    });
  });

  it('maps Render branches to environment names', async () => {
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/projects?')) {
        return Promise.resolve(
          jsonResponse([{ project: { id: 'prj-7', name: 'api-service' } }]),
        );
      }
      if (url.includes('/environments?')) {
        return Promise.resolve(
          jsonResponse([{ environment: { id: 'env-7', name: 'any' } }]),
        );
      }

      return Promise.resolve(
        jsonResponse({
          service: {
            id: 'srv-1',
            name: 'api-service-dev',
          },
        }),
      );
    }) as unknown as typeof fetch;

    const configService = {
      getOrThrow: jest.fn().mockReturnValue({
        envProvisioning: {
          flowciManaged: {
            renderOwnerId: 'tea-configured',
          },
        },
      }),
    };
    const client = new RenderEnvClient(configService as never);

    await expect(
      client.createTarget({
        token: 'rnd',
        repoFullName: 'owner/api-service',
        projectName: 'api-service-dev',
        branchName: 'main',
      }),
    ).resolves.toMatchObject({
      metadata: { renderEnvironmentName: 'production' },
    });
    await expect(
      client.createTarget({
        token: 'rnd',
        repoFullName: 'owner/api-service',
        projectName: 'api-service-dev',
        branchName: 'uat',
      }),
    ).resolves.toMatchObject({
      metadata: { renderEnvironmentName: 'uat' },
    });
  });

  it.each([
    [402, 'Render billing is not configured'],
    [409, 'A Render service with this name already exists'],
    [401, 'Render API key is invalid'],
    [500, 'Render services could not be loaded: 500 server down'],
  ])(
    'maps Render error status %s to actionable errors',
    async (status, message) => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status,
        text: () => Promise.resolve(status === 500 ? 'server down' : ''),
      });

      await expect(new RenderEnvClient().listTargets('rnd')).rejects.toThrow(
        message,
      );
    },
  );

  describe('getTargetStatus', () => {
    it('reports the Render service exists with its state and url', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        jsonResponse({
          service: {
            id: 'srv-1',
            name: 'orders-api-test',
            suspended: 'not_suspended',
            serviceDetails: { url: 'https://orders-api-test.onrender.com' },
          },
        }),
      );

      await expect(
        new RenderEnvClient().getTargetStatus({
          token: 'rnd',
          targetId: 'srv-1',
        }),
      ).resolves.toEqual({
        exists: true,
        state: 'not_suspended',
        url: 'https://orders-api-test.onrender.com',
      });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.render.com/v1/services/srv-1',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer rnd',
          }) as unknown,
        }),
      );
    });

    it('reports the Render service does not exist on a 404', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      });

      await expect(
        new RenderEnvClient().getTargetStatus({
          token: 'rnd',
          targetId: 'srv-missing',
        }),
      ).resolves.toEqual({ exists: false });
    });

    it('throws an actionable error for non-404 failures', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve(''),
      });

      await expect(
        new RenderEnvClient().getTargetStatus({
          token: 'rnd',
          targetId: 'srv-1',
        }),
      ).rejects.toThrow('Render API key is invalid');
    });

    it.each([
      [
        'nested service url/suspended/ownerId',
        {
          service: {
            suspended: 'not_suspended',
            ownerId: 'tea-nested',
            serviceDetails: { url: 'https://nested.onrender.com' },
          },
        },
        {
          exists: true,
          state: 'not_suspended',
          url: 'https://nested.onrender.com',
          metadata: { renderOwnerId: 'tea-nested' },
        },
      ],
      [
        'flat url/suspended/ownerId',
        {
          suspended: 'suspended',
          ownerId: 'tea-flat',
          url: 'https://flat.onrender.com',
        },
        {
          exists: true,
          state: 'suspended',
          url: 'https://flat.onrender.com',
          metadata: { renderOwnerId: 'tea-flat' },
        },
      ],
    ])('maps a %s status payload', async (_label, payload, expected) => {
      global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(payload));

      await expect(
        new RenderEnvClient().getTargetStatus({
          token: 'rnd',
          targetId: 'srv-1',
        }),
      ).resolves.toEqual(expected);
    });
  });

  describe('getDeployHistory', () => {
    it('maps Render deploy events into provider deploy events', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        jsonResponse([
          {
            deploy: {
              id: 'dep-2',
              status: 'live',
              trigger: 'auto_deploy',
              createdAt: '2026-07-12T11:45:00.000Z',
              finishedAt: '2026-07-12T11:48:00.000Z',
              commit: { id: 'ea73844', message: 'feat: add logs endpoint' },
            },
          },
          {
            deploy: {
              id: 'dep-1',
              status: 'build_failed',
              createdAt: '2026-07-12T11:30:00.000Z',
            },
          },
        ]),
      );

      await expect(
        new RenderEnvClient().getDeployHistory({
          token: 'rnd',
          targetId: 'srv-1',
        }),
      ).resolves.toEqual([
        {
          id: 'dep-2',
          status: 'live',
          createdAt: '2026-07-12T11:45:00.000Z',
          readyAt: '2026-07-12T11:48:00.000Z',
          commitSha: 'ea73844',
          commitMessage: 'feat: add logs endpoint',
          createdBy: null,
          trigger: 'auto_deploy',
          // Render serves every deploy from one stable service URL and
          // reports no lane, PR, or per-deploy console link, so callers fall
          // back to what the target knows.
          deploymentUrl: null,
          environment: null,
          pullRequestNumber: null,
          commitRef: null,
          inspectorUrl: null,
        },
        {
          id: 'dep-1',
          status: 'build_failed',
          createdAt: '2026-07-12T11:30:00.000Z',
          readyAt: null,
          commitSha: null,
          commitMessage: null,
          createdBy: null,
          trigger: null,
          deploymentUrl: null,
          environment: null,
          pullRequestNumber: null,
          commitRef: null,
          inspectorUrl: null,
        },
      ]);
      expect(fetch).toHaveBeenCalledWith(
        'https://api.render.com/v1/services/srv-1/deploys?limit=20',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer rnd',
          }) as unknown,
        }),
      );
    });

    it('returns an empty list on a 404', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      });

      await expect(
        new RenderEnvClient().getDeployHistory({
          token: 'rnd',
          targetId: 'srv-missing',
        }),
      ).resolves.toEqual([]);
    });
  });

  describe('queryLogs', () => {
    it('throws a typed rate-limit error on 429 after ONE request, honouring Retry-After and hiding the body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: {
          get: (name: string) => (name === 'retry-after' ? '45' : null),
        },
        text: () => Promise.resolve('{"message": "rate limit exceeded"}'),
      });

      const error = await new RenderEnvClient()
        .queryLogs({ token: 'rnd', targetId: 'srv-1', renderOwnerId: 'own-1' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ProviderRateLimitedError);
      expect((error as ProviderRateLimitedError).retryAfterMs).toBe(45_000);
      expect((error as Error).message).not.toContain('{');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('throws when no Render owner ID is linked, rather than returning an empty page', async () => {
      global.fetch = jest.fn();

      await expect(
        new RenderEnvClient().queryLogs({ token: 'rnd', targetId: 'srv-1' }),
      ).rejects.toThrow(
        'Render owner ID is not linked to this target — run Sync to link it, then reopen logs.',
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('sends the owner-scoped query and maps labels into level/type/instance', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        jsonResponse({
          hasMore: true,
          nextStartTime: '2026-07-12T00:00:05.000Z',
          nextEndTime: '2026-07-12T01:00:00.000Z',
          logs: [
            {
              id: 'log-1',
              timestamp: '2026-07-12T00:00:00.000Z',
              message: 'listening on 10000',
              labels: [
                { name: 'level', value: 'info' },
                { name: 'type', value: 'app' },
                { name: 'instance', value: 'srv-abc123' },
              ],
            },
          ],
        }),
      );

      const page = await new RenderEnvClient().queryLogs({
        token: 'rnd',
        targetId: 'srv-1',
        renderOwnerId: 'owner-1',
        type: ['app'],
        level: ['info'],
        direction: 'forward',
      });

      expect(page).toEqual({
        logs: [
          {
            id: 'log-1',
            timestamp: '2026-07-12T00:00:00.000Z',
            message: 'listening on 10000',
            level: 'info',
            type: 'app',
            instance: 'srv-abc123',
            labels: { level: 'info', type: 'app', instance: 'srv-abc123' },
          },
        ],
        hasMore: true,
        next: {
          startTime: '2026-07-12T00:00:05.000Z',
          endTime: '2026-07-12T01:00:00.000Z',
        },
      });

      const [url, init] = (fetch as jest.Mock).mock.calls[0] as [
        string,
        { headers: Record<string, string> },
      ];
      const requested = new URL(url);
      expect(requested.origin + requested.pathname).toBe(
        'https://api.render.com/v1/logs',
      );
      expect(requested.searchParams.get('ownerId')).toBe('owner-1');
      expect(requested.searchParams.getAll('resource')).toEqual(['srv-1']);
      expect(requested.searchParams.getAll('type')).toEqual(['app']);
      expect(requested.searchParams.getAll('level')).toEqual(['info']);
      expect(requested.searchParams.get('direction')).toBe('forward');
      expect(init.headers['Authorization']).toBe('Bearer rnd');
    });

    it('reverses a default (backward) page so lines tied at the same millisecond come out in emission order', async () => {
      // Render's direction defaults to backward (newest first) when the
      // caller doesn't specify one — queryLogs must pass that through to
      // mapRenderLogsPage so it knows to reverse before its stable sort.
      const tiedTimestamp = '2026-07-12T00:00:00.123Z';
      global.fetch = jest.fn().mockResolvedValueOnce(
        jsonResponse({
          logs: [
            { id: 'c', timestamp: tiedTimestamp, message: 'at inner' },
            { id: 'b', timestamp: tiedTimestamp, message: 'at outer' },
            { id: 'a', timestamp: tiedTimestamp, message: 'TypeError: boom' },
          ],
        }),
      );

      const page = await new RenderEnvClient().queryLogs({
        token: 'rnd',
        targetId: 'srv-1',
        renderOwnerId: 'owner-1',
      });

      expect(page.logs.map((line) => line.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('getLogs (compatibility wrapper over queryLogs)', () => {
    it('flattens the page shape back to the old flat log entry list', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        jsonResponse({
          logs: [
            {
              id: 'log-1',
              timestamp: '2026-07-12T00:00:00.000Z',
              message: 'hello',
              labels: [{ name: 'level', value: 'error' }],
            },
          ],
        }),
      );

      await expect(
        new RenderEnvClient().getLogs({
          token: 'rnd',
          targetId: 'srv-1',
          renderOwnerId: 'owner-1',
          type: 'build',
        }),
      ).resolves.toEqual([
        {
          timestamp: '2026-07-12T00:00:00.000Z',
          message: 'hello',
          level: 'error',
        },
      ]);
      const [url] = (fetch as jest.Mock).mock.calls[0] as [string];
      expect(new URL(url).searchParams.getAll('type')).toEqual(['build']);
    });
  });

  describe('deleteTarget', () => {
    it('deletes the Render service', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await expect(
        new RenderEnvClient().deleteTarget({ token: 'rnd', targetId: 'srv-1' }),
      ).resolves.toEqual({ deleted: true });
      expect(fetch).toHaveBeenCalledWith(
        'https://api.render.com/v1/services/srv-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('treats an already-gone Render service (404) as deleted', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve(''),
      });

      await expect(
        new RenderEnvClient().deleteTarget({
          token: 'rnd',
          targetId: 'srv-missing',
        }),
      ).resolves.toEqual({ deleted: true });
    });
  });

  describe('Render project + environment grouping', () => {
    it('reuses an existing project and environment without creating either', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([{ owner: { id: 'tea-1', name: 'ALPHACI' } }]),
        )
        .mockResolvedValueOnce(
          jsonResponse([{ project: { id: 'prj-hr', name: 'hr-be' } }]),
        )
        .mockResolvedValueOnce(
          jsonResponse([{ environment: { id: 'env-hr-test', name: 'dev' } }]),
        )
        .mockResolvedValueOnce(
          jsonResponse({ service: { id: 'srv-hr', name: 'hr-be-test' } }),
        );
      global.fetch = fetchMock;

      const client = new RenderEnvClient();
      const target = await client.createTarget({
        token: 'rnd',
        repoFullName: 'Alpha-Explora/hr-be',
        projectName: 'hr-be-test',
        branchName: 'dev',
      });

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://api.render.com/v1/projects?ownerId=tea-1&limit=100',
      );
      expect(fetchMock.mock.calls[2][0]).toBe(
        'https://api.render.com/v1/environments?projectId=prj-hr&name=dev&limit=1',
      );
      expect(target.metadata).toMatchObject({
        renderEnvironmentId: 'env-hr-test',
        renderProjectName: 'hr-be',
      });
      const [, createServiceRequest] = fetchMock.mock.calls[3] as [
        string,
        { body: string },
      ];
      expect(JSON.parse(createServiceRequest.body)).toMatchObject({
        environmentId: 'env-hr-test',
      });
    });

    it('creates a missing environment inside an existing project', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([{ owner: { id: 'tea-1', name: 'ALPHACI' } }]),
        )
        .mockResolvedValueOnce(
          jsonResponse([{ project: { id: 'prj-hr', name: 'hr-be' } }]),
        )
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ environment: { id: 'ignored' } }))
        .mockResolvedValueOnce(
          jsonResponse([{ environment: { id: 'env-hr-uat', name: 'uat' } }]),
        )
        .mockResolvedValueOnce(
          jsonResponse({ service: { id: 'srv-hr', name: 'hr-be-uat' } }),
        );
      global.fetch = fetchMock;

      const client = new RenderEnvClient();
      const target = await client.createTarget({
        token: 'rnd',
        repoFullName: 'Alpha-Explora/hr-be',
        projectName: 'hr-be-uat',
        branchName: 'uat',
      });

      expect(fetchMock).toHaveBeenCalledTimes(6);
      const [createEnvUrl, createEnvRequest] = fetchMock.mock.calls[3] as [
        string,
        { method: string; body: string },
      ];
      expect(createEnvUrl).toBe('https://api.render.com/v1/environments');
      expect(createEnvRequest.method).toBe('POST');
      expect(JSON.parse(createEnvRequest.body)).toEqual({
        name: 'uat',
        projectId: 'prj-hr',
      });
      expect(target.metadata).toMatchObject({
        renderEnvironmentId: 'env-hr-uat',
        renderProjectName: 'hr-be',
      });
    });

    it('creates a new project and environment when neither exists', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse([{ owner: { id: 'tea-1', name: 'ALPHACI' } }]),
        )
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ project: { id: 'prj-new' } }))
        .mockResolvedValueOnce(
          jsonResponse([{ environment: { id: 'env-new-test', name: 'dev' } }]),
        )
        .mockResolvedValueOnce(
          jsonResponse({ service: { id: 'srv-new', name: 'hr-be-test' } }),
        );
      global.fetch = fetchMock;

      const client = new RenderEnvClient();
      const target = await client.createTarget({
        token: 'rnd',
        repoFullName: 'Alpha-Explora/hr-be',
        projectName: 'hr-be-test',
        branchName: 'dev',
      });

      expect(fetchMock).toHaveBeenCalledTimes(5);
      const [createProjectUrl, createProjectRequest] = fetchMock.mock
        .calls[2] as [string, { method: string; body: string }];
      expect(createProjectUrl).toBe('https://api.render.com/v1/projects');
      expect(createProjectRequest.method).toBe('POST');
      expect(JSON.parse(createProjectRequest.body)).toEqual({
        name: 'hr-be',
        ownerId: 'tea-1',
        environments: [{ name: 'dev' }],
      });
      expect(target.metadata).toMatchObject({
        renderEnvironmentId: 'env-new-test',
        renderProjectName: 'hr-be',
      });
    });
  });
});
