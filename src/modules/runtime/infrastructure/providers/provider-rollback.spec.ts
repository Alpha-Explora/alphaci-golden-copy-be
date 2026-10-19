import { RenderEnvClient } from './render/render-env.client';
import { VercelEnvClient } from './vercel/vercel-env.client';

const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('provider rollback', () => {
  afterEach(() => jest.restoreAllMocks());

  it('Render: posts the chosen deploy to the rollback endpoint and reports the new deploy', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(ok({ id: 'dep-new', status: 'created' }));
    global.fetch = fetchMock;

    await expect(
      new RenderEnvClient().rollbackDeploy({
        token: 'rnd',
        targetId: 'srv-1',
        deployId: 'dep-2',
      }),
    ).resolves.toEqual({
      deployId: 'dep-new',
      status: 'created',
      holdsNewDeploys: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.render.com/v1/services/srv-1/rollback',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ deployId: 'dep-2' }),
      }),
    );
  });

  it('Render: a refusal becomes an error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad deploy',
      json: async () => ({}),
    });
    await expect(
      new RenderEnvClient().rollbackDeploy({
        token: 'rnd',
        targetId: 'srv-1',
        deployId: 'dep-2',
      }),
    ).rejects.toThrow();
  });

  it('Vercel: Instant Rollback on the team, which holds new production deploys', async () => {
    const fetchMock = jest.fn().mockResolvedValue(ok({}));
    global.fetch = fetchMock;

    await expect(
      new VercelEnvClient().rollbackDeploy({
        token: 'vc',
        targetId: 'prj_1',
        deployId: 'dpl_2',
        vercelTeamId: 'team_1',
      }),
    ).resolves.toEqual({
      deployId: 'dpl_2',
      status: 'rolling_back',
      holdsNewDeploys: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.vercel.com/v9/projects/prj_1/rollback/dpl_2?teamId=team_1',
    );
    expect(init.method).toBe('POST');
  });

  it('Vercel: resume promotes the newest ready production deployment', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(ok({ deployments: [{ uid: 'dpl_5' }] }))
      .mockResolvedValueOnce(ok({}));
    global.fetch = fetchMock;

    await expect(
      new VercelEnvClient().resumeDeploys({
        token: 'vc',
        targetId: 'prj_1',
        vercelTeamId: 'team_1',
      }),
    ).resolves.toEqual({ deployId: 'dpl_5' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.vercel.com/v6/deployments?projectId=prj_1&target=production&state=READY&limit=1&teamId=team_1',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.vercel.com/v10/projects/prj_1/promote/dpl_5?teamId=team_1',
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  it('Vercel: resume with no ready production deployment promotes nothing', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(ok({ deployments: [] }));
    global.fetch = fetchMock;
    await expect(
      new VercelEnvClient().resumeDeploys({ token: 'vc', targetId: 'prj_1' }),
    ).resolves.toEqual({ deployId: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
