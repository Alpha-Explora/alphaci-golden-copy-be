import { SonarCloudSetupService } from './sonar-cloud-setup.service';

/*
 * SonarCloud turns Automatic Analysis on for every project the org's GitHub
 * App binds, and then refuses each CI scan ("You are running CI analysis while
 * Automatic Analysis is enabled"). Provisioning switches it off right after the
 * project exists; the repair does the same for older projects.
 */
describe('SonarCloudSetupService Automatic Analysis', () => {
  const configService = (sonarToken?: string, sonarOrganization?: string) => ({
    getOrThrow: jest.fn().mockReturnValue({
      envProvisioning: { flowciManaged: { sonarToken, sonarOrganization } },
    }),
  });
  const ensureInput = {
    sonarToken: 'sonar-token',
    sonarOrganization: 'alphaci',
    sonarProjectKey: 'tone_shop-fe',
    projectName: 'shop-fe',
    repoFullName: 'tone/shop-fe',
  };
  type EnsureProject = {
    ensureSonarCloudProject(input: typeof ensureInput): Promise<void>;
  };

  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  const calledUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

  const autoscanCall = () =>
    fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/api/autoscan/activation'),
    ) as [string, RequestInit] | undefined;

  function service() {
    return new SonarCloudSetupService(
      {} as never,
      configService('sonar-token', 'alphaci') as never,
    );
  }

  it('switches Automatic Analysis off right after creating the project', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await (service() as unknown as EnsureProject).ensureSonarCloudProject(
      ensureInput,
    );

    const urls = calledUrls();
    const create = urls.findIndex((url) =>
      url.endsWith('/api/projects/create'),
    );
    const autoscan = urls.findIndex((url) =>
      url.endsWith('/api/autoscan/activation'),
    );
    expect(create).toBeGreaterThanOrEqual(0);
    expect(autoscan).toBeGreaterThan(create);

    const [, init] = autoscanCall()!;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('projectKey=tone_shop-fe&enable=false');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sonar-token',
    );
  });

  it('switches it off when the project already exists', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/api/projects/create')
          ? new Response('Could not create Project, key already exists', {
              status: 400,
            })
          : new Response('{}', { status: 200 }),
      ),
    );

    await (service() as unknown as EnsureProject).ensureSonarCloudProject(
      ensureInput,
    );

    expect(autoscanCall()).toBeDefined();
  });

  it('does not try when the project could not be created', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/api/projects/create')
          ? new Response('Insufficient privileges', { status: 403 })
          : new Response('{}', { status: 200 }),
      ),
    );

    await (service() as unknown as EnsureProject).ensureSonarCloudProject(
      ensureInput,
    );

    expect(autoscanCall()).toBeUndefined();
  });

  it('never fails provisioning when SonarCloud refuses the switch', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/api/autoscan/activation')
          ? new Response('Unknown url', { status: 404 })
          : new Response('{}', { status: 200 }),
      ),
    );

    await expect(
      (service() as unknown as EnsureProject).ensureSonarCloudProject(
        ensureInput,
      ),
    ).resolves.toBeUndefined();
  });

  it('repairs an existing project and says whether it worked', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      service().disableAutomaticAnalysis('tone_shop-fe'),
    ).resolves.toEqual({
      projectKey: 'tone_shop-fe',
      disabled: true,
      message: 'Automatic Analysis is disabled.',
    });
  });

  it('reports a refusal from the repair without throwing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Insufficient privileges', { status: 403 }),
    );

    await expect(
      service().disableAutomaticAnalysis('tone_shop-fe'),
    ).resolves.toEqual({
      projectKey: 'tone_shop-fe',
      disabled: false,
      message: expect.stringContaining('403'),
    });
  });

  it('reports a network failure from the repair without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(
      service().disableAutomaticAnalysis('tone_shop-fe'),
    ).resolves.toMatchObject({ disabled: false });
  });

  it('says so when SonarCloud is not configured', async () => {
    const unconfigured = new SonarCloudSetupService(
      {} as never,
      configService(undefined, undefined) as never,
    );

    await expect(
      unconfigured.disableAutomaticAnalysis('tone_shop-fe'),
    ).resolves.toEqual({
      projectKey: 'tone_shop-fe',
      disabled: false,
      message: 'ALPHACI_SONAR_TOKEN is not configured.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
