import { Logger } from '@nestjs/common';

import { ProjectProvisioningSupport } from './project-provisioning.support';

/*
 * The workflow files and the provider resources are produced by two different
 * steps from one request, and only the first has to succeed for a project to be
 * reported as provisioned. A React project came out of that with three Vercel
 * deploy jobs committed and zero deployment targets stored - and said nothing.
 *
 * The warning is the whole fix, so it is the thing worth a test: without it the
 * mismatch is discovered much later, in another repository, as a credential
 * error that names none of this.
 */
describe('ProjectProvisioningSupport, deploy jobs with no target', () => {
  const request = {
    enabled: true,
    targets: [
      { slot: 'frontend', provider: 'vercel', ownershipMode: 'flowci_managed' },
    ],
  };

  const makeSupport = (provisionForProject: jest.Mock) =>
    new ProjectProvisioningSupport({
      catalogService: {} as never,
      githubService: {} as never,
      projectsRepository: {} as never,
      ciService: {} as never,
      projectDeploymentProvisioningService: { provisionForProject } as never,
      deploymentProvisioningDefaults: undefined,
      configService: undefined,
      usageQuotaService: undefined,
      auditEventsService: undefined,
      workspacesService: undefined,
      notificationEventPublisher: undefined,
      auditEventPublisher: undefined,
      hierarchyProjectLinkService: undefined,
      workflowFilePusher: undefined,
      workflowFragmentRegistry: undefined,
    });

  const invoke = (support: ProjectProvisioningSupport) =>
    support.provisionDeploymentTargets({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'acme/storefront',
      githubAccessToken: 'token',
      request: request as never,
      slots: ['frontend'],
    });

  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('names the provider, the repository and the consequence', async () => {
    const support = makeSupport(
      jest.fn().mockResolvedValue({
        status: 'failed',
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            status: 'failed',
            errorSummary: 'Vercel token is empty',
          },
        ],
      }),
    );

    await invoke(support);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('vercel/frontend');
    expect(message).toContain('Vercel token is empty');
    expect(message).toContain('acme/storefront');
    // The consequence, not just the fact. "provisioning failed" sends nobody
    // to the repository that now carries unusable deploy jobs.
    expect(message).toContain('deploy jobs');
  });

  it('also warns when provisioning throws', async () => {
    const support = makeSupport(
      jest.fn().mockRejectedValue(new Error('Vercel API unreachable')),
    );

    const result = await invoke(support);

    expect(result.status).toBe('failed');
    // Two warnings: the caught error, then the stranded deploy jobs. The second
    // is the one that says what it means for the repository.
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('deploy jobs'))).toBe(
      true,
    );
  });

  it('stays quiet when every target was created', async () => {
    const support = makeSupport(
      jest.fn().mockResolvedValue({
        status: 'completed',
        targets: [{ slot: 'frontend', provider: 'vercel', status: 'created' }],
      }),
    );

    await invoke(support);

    expect(warn).not.toHaveBeenCalled();
  });
});
