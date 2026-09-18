import { BadRequestException } from '@nestjs/common';

import type { DeploymentTargetSummary } from '../../../core/deployments.types';
import { RenderCiSecretsService } from './render-ci-secrets.service';

describe('RenderCiSecretsService', () => {
  const githubService = {
    setActionsSecretStrict: jest.fn(),
    setActionsVariableStrict: jest.fn(),
  };

  const baseTarget: DeploymentTargetSummary = {
    id: 'target-1',
    projectId: 'project-1',
    slot: 'backend',
    ownershipMode: 'flowci_managed',
    provider: 'render',
    providerConnectionId: null,
    providerProjectId: 'srv-1',
    providerProjectName: 'orders-api-uat',
    repoFullName: 'tone/orders-api',
    branchName: 'uat',
    rootDirectory: 'backend',
    buildCommand: null,
    startCommand: null,
    renderServiceType: 'web_service',
    renderInstanceType: 'free',
    renderRegion: 'singapore',
    renderEnvironmentName: 'uat',
    dockerContext: 'backend',
    dockerfilePath: 'backend/Dockerfile',
    imageUrl: null,
    environmentMap: {},
    deploymentStrategy: 'render_image_pushed',
    providerMetadata: {
      renderOwnerId: 'tea-flowci',
      renderRegistryCredentialId: 'crd-flowci',
      renderServiceUrl: 'https://orders-api-uat.onrender.com',
    },
    status: 'active',
  };

  let service: RenderCiSecretsService;

  beforeEach(() => {
    jest.clearAllMocks();
    githubService.setActionsSecretStrict.mockResolvedValue(undefined);
    githubService.setActionsVariableStrict.mockResolvedValue(undefined);
    service = new RenderCiSecretsService(githubService);
  });

  function install(target: DeploymentTargetSummary = baseTarget) {
    return service.installForTarget({
      githubAccessToken: 'gh-token',
      repoFullName: 'tone/orders-api',
      userId: 'user-1',
      providerConnectionId: null,
      target,
    });
  }

  it('installs the service address so a run can reach the deployment', async () => {
    const result = await install();

    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_HEALTHCHECK_URL_UAT',
      'https://orders-api-uat.onrender.com',
    );
    expect(result.githubSecrets).toEqual({
      healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
    });
  });

  /*
   * The same address as a secret AND as a variable, which is not redundancy.
   *
   * render-deploy.yml is handed it through `secrets:`, while the post-deploy
   * verify stage is triggered by `workflow_run` and can only be handed a
   * variable: GitHub rejects a workflow file that names a secret inside a
   * reusable-workflow `with:` block, and redacts one routed through a job
   * output. Installing only the secret is what made every post-deploy API
   * test fail with "Repository variable RENDER_HEALTHCHECK_URL_UAT is not
   * set" on a repository where that secret demonstrably existed.
   */
  it('publishes the service address as a variable as well as a secret', async () => {
    const result = await install();

    expect(githubService.setActionsVariableStrict).toHaveBeenCalledWith(
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_HEALTHCHECK_URL_UAT',
      'https://orders-api-uat.onrender.com',
    );
    expect(result.githubVariables).toEqual({
      healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
    });
  });

  it('publishes no variable when the target has no resolvable address', async () => {
    await install({ ...baseTarget, providerMetadata: {} });

    expect(githubService.setActionsVariableStrict).not.toHaveBeenCalled();
  });

  /*
   * The regression this class exists to prevent now.
   *
   * It used to write the platform's Render API key, owner id and service id
   * into every customer repository. Render issues a key on an account and
   * offers no way to scope it to one service, so anyone able to push a workflow
   * to any generated repository could manage every service on the account -
   * including the platform's own. The release runs on the platform instead, so
   * no credential belongs in the repository at all.
   */
  it('never writes a Render credential into a customer repository', async () => {
    await install();

    const names = githubService.setActionsSecretStrict.mock.calls.map((call) =>
      String(call[3]),
    );
    const values = githubService.setActionsSecretStrict.mock.calls.map((call) =>
      String(call[4]),
    );

    expect(names).not.toContain(expect.stringContaining('API_KEY'));
    expect(names.join(',')).not.toMatch(/API_KEY|OWNER_ID|SERVICE_ID/);
    expect(values.join(',')).not.toMatch(/^rnd_/m);
  });

  it('names the secret after the branch the target deploys', async () => {
    await install({ ...baseTarget, branchName: 'main' });

    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_HEALTHCHECK_URL_MAIN',
      expect.any(String),
    );
  });

  /*
   * dev is not hosted, so it has no service and no secret of its own. The name
   * falls back to the first hosted tier rather than to production: a target
   * that should never have reached here must not end up addressing the
   * customer's live environment.
   */
  it('falls back to the first hosted tier for an unhosted branch', async () => {
    await install({ ...baseTarget, branchName: 'dev' });

    expect(githubService.setActionsSecretStrict).toHaveBeenCalledWith(
      'gh-token',
      'tone',
      'orders-api',
      'RENDER_HEALTHCHECK_URL_UAT',
      expect.any(String),
    );
  });

  it('writes nothing for a target it does not handle', async () => {
    const result = await install({
      ...baseTarget,
      deploymentStrategy: 'render_git_connected',
    });

    expect(githubService.setActionsSecretStrict).not.toHaveBeenCalled();
    expect(result.githubSecrets).toEqual({
      healthcheckUrl: 'RENDER_HEALTHCHECK_URL_UAT',
    });
  });

  it('writes nothing when the service has no address yet', async () => {
    await install({ ...baseTarget, providerMetadata: {} });

    expect(githubService.setActionsSecretStrict).not.toHaveBeenCalled();
  });

  it('rejects a malformed repository name', async () => {
    await expect(
      service.installForTarget({
        githubAccessToken: 'gh-token',
        repoFullName: 'not-a-repo',
        userId: 'user-1',
        providerConnectionId: null,
        target: baseTarget,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
