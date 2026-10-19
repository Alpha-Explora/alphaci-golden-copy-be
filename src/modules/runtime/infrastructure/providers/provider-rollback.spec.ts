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

  it('Vercel: history adds the production deployments the newest 20 previews pushed out, once each, newest first', async () => {
    const row = (uid: string, createdAt: number, target: string | null) => ({
      uid,
      target,
      readyState: 'READY',
      createdAt,
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        ok({
          deployments: [row('dpl_p2', 300, null), row('dpl_p1', 200, null)],
        }),
      )
      .mockResolvedValueOnce(
        ok({
          deployments: [
            row('dpl_prod2', 100, 'production'),
            row('dpl_prod1', 50, 'production'),
          ],
        }),
      );
    global.fetch = fetchMock;

    const events = await new VercelEnvClient().getDeployHistory({
      token: 'vc',
      targetId: 'prj_1',
      vercelTeamId: 'team_1',
    });
    expect(events.map(({ id, environment }) => [id, environment])).toEqual([
      ['dpl_p2', 'preview'],
      ['dpl_p1', 'preview'],
      ['dpl_prod2', 'production'],
      ['dpl_prod1', 'production'],
    ]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.vercel.com/v6/deployments?projectId=prj_1&target=production&limit=10&teamId=team_1',
    );
  });

  it('Vercel: a failed production read leaves the recent history as it was', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        ok({
          deployments: [{ uid: 'dpl_p1', readyState: 'READY', createdAt: 1 }],
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
    const events = await new VercelEnvClient().getDeployHistory({
      token: 'vc',
      targetId: 'prj_1',
    });
    expect(events.map(({ id }) => id)).toEqual(['dpl_p1']);
  });

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
