import { SonarCloudSetupService } from './sonar-cloud-setup.service';

describe('SonarCloudSetupService.deleteProject', () => {
  const configService = (sonarToken?: string, sonarOrganization?: string) => ({
    getOrThrow: jest.fn().mockReturnValue({
      envProvisioning: { flowciManaged: { sonarToken, sonarOrganization } },
    }),
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('deletes the project when it exists in the managed organization', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ components: [{ key: 'tone_orders-api' }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const service = new SonarCloudSetupService(
      {} as never,
      configService('sonar-token', 'alphaci') as never,
    );

    await expect(service.deleteProject('tone', 'orders-api')).resolves.toEqual({
      status: 'deleted',
      sonarProjectKey: 'tone_orders-api',
    });

    const [searchUrl] = fetchMock.mock.calls[0] as [string];
    expect(searchUrl).toContain('organization=alphaci');
    expect(searchUrl).toContain('projects=tone_orders-api');
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(deleteUrl).toBe('https://sonarcloud.io/api/projects/delete');
    expect(deleteInit.method).toBe('POST');
    expect(String(deleteInit.body)).toBe('project=tone_orders-api');
  });

  it('does not delete a key that is not in the managed organization', async () => {
    fetchMock.mockResolvedValueOnce(json({ components: [] }));
    const service = new SonarCloudSetupService(
      {} as never,
      configService('sonar-token', 'alphaci') as never,
    );

    await expect(service.deleteProject('tone', 'orders-api')).resolves.toEqual({
      status: 'not_found',
      sonarProjectKey: 'tone_orders-api',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a failure without throwing when the delete call fails', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ components: [{ key: 'tone_orders-api' }] }))
      .mockResolvedValueOnce(
        new Response('Insufficient privileges', { status: 403 }),
      );
    const service = new SonarCloudSetupService(
      {} as never,
      configService('sonar-token', 'alphaci') as never,
    );

    await expect(service.deleteProject('tone', 'orders-api')).resolves.toEqual({
      status: 'failed',
      sonarProjectKey: 'tone_orders-api',
      message: expect.stringContaining('403'),
    });
  });

  it('reports a failure when SonarCloud is not configured', async () => {
    const service = new SonarCloudSetupService(
      {} as never,
      configService() as never,
    );

    await expect(service.deleteProject('tone', 'orders-api')).resolves.toEqual(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
