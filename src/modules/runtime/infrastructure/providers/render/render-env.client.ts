import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '#kernel/config/app.config';
import { throwIfRateLimited } from '../core/fetch-with-retry';
import type {
  CreateProviderTargetInput,
  DeleteProviderEnvInput,
  DeleteProviderTargetInput,
  DeleteProviderTargetResult,
  ProviderAccountSummary,
  ProviderDeployEvent,
  ProviderDeploymentTarget,
  ProviderLogEntry,
  ProviderLogPage,
  ProviderLogQuery,
  ProviderLogsInput,
  ProviderProvisionResult,
  ProviderTargetStatus,
  ProviderTargetStatusInput,
  UpsertProviderEnvInput,
} from '../../../application/ports/runtime-env-provider.client';
import type { DeploymentProvider } from '../../../core/deployment-provider-runtime.contract';
import {
  buildRenderLogsQueryParams,
  mapRenderLogsPage,
  readCreatedService,
  readServiceStatus,
  type RenderCreatedServicePayload,
  type RenderLogsPayload,
  type RenderServiceStatusPayload,
} from './render-env.mapping';

const RENDER_API_URL = 'https://api.render.com/v1';

@Injectable()
export class RenderEnvClient implements DeploymentProvider {
  readonly provider = 'render' as const;

  constructor(private readonly configService?: ConfigService) {}

  async validateConnection(token: string): Promise<ProviderAccountSummary> {
    const response = await fetch(`${RENDER_API_URL}/owners?limit=1`, {
      headers: this.headers(token),
    });
    await this.assertOk(response, 'Render connection validation failed');
    const owners = (await response.json()) as Array<{
      owner?: { id?: string; name?: string };
    }>;
    const owner = owners[0]?.owner;
    return {
      id: owner?.id ?? 'render-account',
      name: owner?.name ?? 'Render account',
      metadata: {
        ownerId: owner?.id ?? 'render-account',
        ownerName: owner?.name ?? 'Render account',
      },
    };
  }

  async listTargets(token: string): Promise<ProviderDeploymentTarget[]> {
    const response = await fetch(`${RENDER_API_URL}/services?limit=100`, {
      headers: this.headers(token),
    });
    await this.assertOk(response, 'Render services could not be loaded');
    const services = (await response.json()) as Array<{
      service?: { id?: string; name?: string };
    }>;

    return services
      .map((item) => item.service)
      .filter((service): service is { id: string; name: string } =>
        Boolean(service?.id && service?.name),
      )
      .map((service) => ({
        id: service.id,
        name: service.name,
        provider: this.provider,
      }));
  }

  async createTarget(
    input: CreateProviderTargetInput,
  ): Promise<ProviderDeploymentTarget> {
    const ownerId =
      this.getConfiguredOwnerId() ??
      (await this.getDefaultOwnerId(input.token));
    const renderEnvironmentName =
      input.renderEnvironmentName ??
      this.environmentFromBranch(input.branchName);
    const renderProjectName = this.deriveProjectName(input.repoFullName);
    const environmentId = await this.getOrCreateEnvironmentId(
      input.token,
      ownerId,
      input.repoFullName,
      renderEnvironmentName,
    );
    const response = await fetch(`${RENDER_API_URL}/services`, {
      method: 'POST',
      headers: this.headers(input.token),
      body: JSON.stringify(
        this.buildCreateServiceBody(input, ownerId, environmentId),
      ),
    });
    await this.assertOk(response, 'Render service could not be created');
    const created = readCreatedService(
      (await response.json()) as RenderCreatedServicePayload,
    );
    if (!created) {
      throw new Error('Render service creation returned an invalid response');
    }
    const renderServiceType = input.renderServiceType ?? 'web_service';
    const renderRuntime =
      input.renderRuntime ?? this.resolveRenderRuntime(input);
    const dockerContext =
      input.dockerContext ?? input.rootDirectory?.trim() ?? '.';
    const dockerfilePath = input.dockerfilePath ?? 'Dockerfile';

    return {
      id: created.id,
      name: created.name,
      provider: this.provider,
      metadata: {
        deploymentStrategy: input.deploymentStrategy ?? 'render_git_connected',
        renderServiceId: created.id,
        renderOwnerId: ownerId,
        renderServiceType,
        renderRuntime,
        renderInstanceType: input.renderInstanceType ?? null,
        renderRegion: input.renderRegion ?? null,
        renderEnvironmentName,
        renderEnvironmentId: environmentId,
        renderProjectName,
        renderServiceUrl: created.url,
        renderRegistryCredentialId: this.getRegistryCredentialId(),
        dockerContext,
        dockerfilePath,
        imageUrl:
          input.deploymentStrategy === 'render_image_pushed'
            ? (input.imageUrl ?? this.getBootstrapImage())
            : null,
        bootstrapImage:
          input.deploymentStrategy === 'render_image_pushed'
            ? this.getBootstrapImage()
            : null,
      },
    };
  }

  /**
   * Writes the whole env-var set for the service.
   *
   * `lane` and `gitBranch` are deliberately unused: a Render service holds one
   * set of variables, so there is nothing to scope them to. Per-branch values
   * on Render would mean one service per branch, which this product does not
   * provision. Capabilities advertises `perBranchEnvVars: ['vercel']` so the UI
   * can say so rather than implying an isolation that does not exist.
   */
  async upsertEnvironmentVariables(
    input: UpsertProviderEnvInput,
  ): Promise<ProviderProvisionResult> {
    const currentResponse = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}/env-vars`,
      { headers: this.headers(input.token) },
    );
    await this.assertOk(currentResponse, 'Render env vars could not be loaded');
    const current = (await currentResponse.json()) as Array<{
      envVar?: { key?: string; value?: string };
    }>;
    const merged = new Map<string, string>();
    for (const item of current) {
      if (item.envVar?.key) {
        merged.set(item.envVar.key, item.envVar.value ?? '');
      }
    }
    for (const variable of input.vars) {
      merged.set(variable.key, variable.value);
    }

    const response = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}/env-vars`,
      {
        method: 'PUT',
        headers: this.headers(input.token),
        body: JSON.stringify(
          [...merged.entries()].map(([key, value]) => ({ key, value })),
        ),
      },
    );
    await this.assertOk(response, 'Render env vars could not be updated');

    return {
      provisioned: input.vars.map((variable) => ({
        key: variable.key,
        status: 'provisioned',
      })),
      failed: [],
    };
  }

  /** Scope-blind for the same reason as the upsert above: one set per service. */
  async deleteEnvironmentVariable(
    input: DeleteProviderEnvInput,
  ): Promise<{ key: string; status: 'removed' }> {
    const currentResponse = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}/env-vars`,
      { headers: this.headers(input.token) },
    );
    await this.assertOk(currentResponse, 'Render env vars could not be loaded');
    const current = (await currentResponse.json()) as Array<{
      envVar?: { key?: string; value?: string };
    }>;
    const remaining = current
      .map((item) => item.envVar)
      .filter((item): item is { key: string; value?: string } =>
        Boolean(item?.key && item.key !== input.key),
      )
      .map((item) => ({ key: item.key, value: item.value ?? '' }));

    const response = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}/env-vars`,
      {
        method: 'PUT',
        headers: this.headers(input.token),
        body: JSON.stringify(remaining),
      },
    );
    await this.assertOk(response, 'Render env vars could not be updated');

    return { key: input.key, status: 'removed' };
  }

  async getTargetStatus(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderTargetStatus> {
    const response = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}`,
      { headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return { exists: false };
    }
    await this.assertOk(response, 'Render service status could not be loaded');
    const status = readServiceStatus(
      (await response.json()) as RenderServiceStatusPayload,
    );

    return {
      exists: true,
      ...(status.state !== undefined ? { state: status.state } : {}),
      url: status.url,
      ...(status.ownerId
        ? { metadata: { renderOwnerId: status.ownerId } }
        : {}),
    };
  }

  async deleteTarget(
    input: DeleteProviderTargetInput,
  ): Promise<DeleteProviderTargetResult> {
    const response = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}`,
      { method: 'DELETE', headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return { deleted: true };
    }
    await this.assertOk(response, 'Render service could not be deleted');

    return { deleted: true };
  }

  async getDeployHistory(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderDeployEvent[]> {
    const response = await fetch(
      `${RENDER_API_URL}/services/${input.targetId}/deploys?limit=20`,
      { headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return [];
    }
    await this.assertOk(response, 'Render deploy history could not be loaded');
    const payload = (await response.json()) as Array<{
      deploy?: {
        id?: string;
        status?: string;
        trigger?: string;
        createdAt?: string;
        finishedAt?: string;
        commit?: { id?: string; message?: string };
      };
    }>;

    return payload
      .map((item) => item.deploy)
      .filter((deploy): deploy is NonNullable<typeof deploy> =>
        Boolean(deploy?.id),
      )
      .map((deploy) => ({
        id: deploy.id as string,
        status: deploy.status ?? 'unknown',
        createdAt: deploy.createdAt ?? new Date().toISOString(),
        readyAt: deploy.finishedAt ?? null,
        commitSha: deploy.commit?.id ?? null,
        commitMessage: deploy.commit?.message ?? null,
        // Render's deploy payload names the trigger, not a person.
        createdBy: null,
        trigger: deploy.trigger ?? null,
        // Render serves every deploy of a service from one stable URL, and
        // its deploy payload carries no lane, PR, or per-deploy console
        // link. Callers fall back to the target's public URL for the first
        // of these; the rest have no Render equivalent. Render's own preview
        // environments are a separate API surface and are not wired up.
        deploymentUrl: null,
        environment: null,
        pullRequestNumber: null,
        commitRef: null,
        inspectorUrl: null,
      }));
  }

  async queryLogs(input: ProviderLogQuery): Promise<ProviderLogPage> {
    // Render's log API is keyed by workspace owner, not just the service.
    // Throwing (rather than returning an empty page) matters here: callers
    // must be able to tell "this target isn't linked yet" apart from
    // "Render genuinely has zero log lines right now" — collapsing them into
    // the same empty result would silently misreport an unlinked target as
    // live-but-quiet.
    if (!input.renderOwnerId?.trim()) {
      throw new Error(
        'Render owner ID is not linked to this target — run Sync to link it, then reopen logs.',
      );
    }

    const params = buildRenderLogsQueryParams(
      input.renderOwnerId,
      input.targetId,
      input,
    );
    // Plain fetch, not fetchWithRetry: this is the polled path (every open log
    // console, via the shared poller), and retrying a 429 here would add
    // requests while the key is already limited. A final 429 becomes a typed
    // error so the caller can cool down for as long as Render asks.
    const response = await fetch(
      `${RENDER_API_URL}/logs?${params.toString()}`,
      { headers: this.headers(input.token) },
    );
    throwIfRateLimited(response, 'Render');
    await this.assertOk(response, 'Render logs could not be loaded');
    const data = (await response.json()) as RenderLogsPayload;

    // mapRenderLogsPage needs the direction actually requested (defaulting
    // to 'backward', same as buildRenderLogsQueryParams above) to know
    // whether the payload arrived newest-first and must be reversed before
    // its stable sort.
    return mapRenderLogsPage(data, input.direction ?? 'backward');
  }

  /**
   * Thin compatibility wrapper: queryLogs owns the real Render mapping
   * (including the label -> level/type/instance fix), this just flattens its
   * richer page shape back to the pre-parity return type for any caller
   * still on the old operation.
   */
  async getLogs(input: ProviderLogsInput): Promise<ProviderLogEntry[]> {
    const { type, ...rest } = input;
    const page = await this.queryLogs({
      ...rest,
      ...(type ? { type: [type] } : {}),
    });

    return page.logs.map((line) => ({
      timestamp: line.timestamp,
      message: line.message,
      level: line.level,
    }));
  }

  private async getDefaultOwnerId(token: string): Promise<string> {
    const response = await fetch(`${RENDER_API_URL}/owners?limit=1`, {
      headers: this.headers(token),
    });
    await this.assertOk(response, 'Render workspace could not be loaded');
    const owners = (await response.json()) as Array<{
      owner?: { id?: string };
    }>;
    const ownerId = owners[0]?.owner?.id;
    if (!ownerId) {
      throw new Error('Render workspace lookup returned no owner id');
    }

    return ownerId;
  }

  private buildCreateServiceBody(
    input: CreateProviderTargetInput,
    ownerId: string,
    environmentId: string,
  ): Record<string, unknown> {
    const type = input.renderServiceType ?? 'web_service';
    const serviceDetails = this.serviceDetails(input);
    if (input.deploymentStrategy === 'render_image_pushed') {
      return {
        type,
        name: input.projectName,
        ownerId,
        environmentId,
        autoDeploy: 'no',
        image: {
          ownerId,
          imagePath: input.imageUrl ?? this.getBootstrapImage(),
          ...(this.getRegistryCredentialId()
            ? { registryCredentialId: this.getRegistryCredentialId() }
            : {}),
        },
        serviceDetails,
      };
    }

    return {
      type,
      name: input.projectName,
      ownerId,
      environmentId,
      repo: `https://github.com/${input.repoFullName}`,
      branch: input.branchName,
      rootDir: input.rootDirectory,
      ...(this.resolveRenderRuntime(input) !== 'docker'
        ? {
            buildCommand: input.buildCommand,
            startCommand: input.startCommand,
          }
        : {}),
      serviceDetails,
    };
  }

  private serviceDetails(
    input: CreateProviderTargetInput,
  ): Record<string, unknown> {
    const runtime = this.resolveRenderRuntime(input);

    return {
      runtime,
      ...(input.renderInstanceType ? { plan: input.renderInstanceType } : {}),
      ...(input.renderRegion ? { region: input.renderRegion } : {}),
      ...(input.startCommand && runtime !== 'image' && runtime !== 'docker'
        ? { startCommand: input.startCommand }
        : {}),
      ...(input.buildCommand && runtime !== 'image' && runtime !== 'docker'
        ? { buildCommand: input.buildCommand }
        : {}),
    };
  }

  private resolveRenderRuntime(input: CreateProviderTargetInput): string {
    if (input.deploymentStrategy === 'render_image_pushed') {
      return 'image';
    }

    return input.renderRuntime ?? 'node';
  }

  private getBootstrapImage(): string {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return (
      config?.envProvisioning.flowciManaged.renderBootstrapImage ??
      'docker.io/library/nginx:alpine'
    );
  }

  private getRegistryCredentialId(): string | null {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return (
      config?.envProvisioning.flowciManaged.renderRegistryCredentialId?.trim() ||
      null
    );
  }

  private environmentFromBranch(
    branchName: string | undefined,
  ): 'dev' | 'uat' | 'production' {
    if (branchName === 'main') {
      return 'production';
    }
    if (branchName === 'uat' || branchName === 'production') {
      return branchName;
    }

    return 'dev';
  }

  private async getOrCreateEnvironmentId(
    token: string,
    ownerId: string,
    repoFullName: string,
    renderEnvironmentName: string,
  ): Promise<string> {
    const projectName = this.deriveProjectName(repoFullName);
    const project = await this.findRenderProject(token, ownerId, projectName);

    if (project) {
      const existingEnvironmentId = await this.findRenderEnvironmentId(
        token,
        project.id,
        renderEnvironmentName,
      );
      if (existingEnvironmentId) {
        return existingEnvironmentId;
      }

      await this.createRenderEnvironment(
        token,
        project.id,
        renderEnvironmentName,
      );
      const createdEnvironmentId = await this.findRenderEnvironmentId(
        token,
        project.id,
        renderEnvironmentName,
      );
      if (!createdEnvironmentId) {
        throw new Error(
          'Render environment creation returned no environment id',
        );
      }

      return createdEnvironmentId;
    }

    const createdProjectId = await this.createRenderProject(
      token,
      ownerId,
      projectName,
      renderEnvironmentName,
    );
    const newEnvironmentId = await this.findRenderEnvironmentId(
      token,
      createdProjectId,
      renderEnvironmentName,
    );
    if (!newEnvironmentId) {
      throw new Error('Render project creation returned no environment id');
    }

    return newEnvironmentId;
  }

  private deriveProjectName(repoFullName: string): string {
    const parts = repoFullName.split('/');
    return parts[parts.length - 1]?.trim() || repoFullName;
  }

  private async findRenderProject(
    token: string,
    ownerId: string,
    projectName: string,
  ): Promise<{ id: string; name: string } | null> {
    const response = await fetch(
      `${RENDER_API_URL}/projects?ownerId=${encodeURIComponent(ownerId)}&limit=100`,
      { headers: this.headers(token) },
    );
    await this.assertOk(response, 'Render projects could not be loaded');
    const projects = (await response.json()) as Array<{
      project?: { id?: string; name?: string };
    }>;

    const match = projects
      .map((item) => item.project)
      .filter((project): project is { id: string; name: string } =>
        Boolean(project?.id && project?.name),
      )
      .find((project) => project.name === projectName);

    return match ?? null;
  }

  private async findRenderEnvironmentId(
    token: string,
    projectId: string,
    environmentName: string,
  ): Promise<string | null> {
    const response = await fetch(
      `${RENDER_API_URL}/environments?projectId=${encodeURIComponent(
        projectId,
      )}&name=${encodeURIComponent(environmentName)}&limit=1`,
      { headers: this.headers(token) },
    );
    await this.assertOk(response, 'Render environments could not be loaded');
    const environments = (await response.json()) as Array<{
      environment?: { id?: string; name?: string; projectId?: string };
    }>;

    const match = environments
      .map((item) => item.environment)
      .filter((environment): environment is { id: string } =>
        Boolean(environment?.id),
      )[0];

    return match?.id ?? null;
  }

  private async createRenderEnvironment(
    token: string,
    projectId: string,
    environmentName: string,
  ): Promise<void> {
    const response = await fetch(`${RENDER_API_URL}/environments`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ name: environmentName, projectId }),
    });
    await this.assertOk(response, 'Render environment could not be created');
  }

  private async createRenderProject(
    token: string,
    ownerId: string,
    projectName: string,
    environmentName: string,
  ): Promise<string> {
    const response = await fetch(`${RENDER_API_URL}/projects`, {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        name: projectName,
        ownerId,
        environments: [{ name: environmentName }],
      }),
    });
    await this.assertOk(response, 'Render project could not be created');
    const payload = (await response.json()) as {
      id?: string;
      project?: { id?: string };
    };
    const projectId = payload.project?.id ?? payload.id;
    if (!projectId) {
      throw new Error('Render project creation returned an invalid response');
    }

    return projectId;
  }

  private getConfiguredOwnerId(): string | null {
    const ownerId = this.configService
      ?.getOrThrow<AppConfig>('app')
      .envProvisioning.flowciManaged.renderOwnerId?.trim();

    return ownerId || null;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async assertOk(response: Response, message: string): Promise<void> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 402) {
        throw new Error(
          'Render billing is not configured for this workspace or the selected instance type requires payment.',
        );
      }
      if (response.status === 409) {
        throw new Error(
          'A Render service with this name already exists in the selected workspace.',
        );
      }
      if (response.status === 401) {
        throw new Error(
          'Render API key is invalid or missing required workspace access.',
        );
      }

      const summary = body ? ` ${body.slice(0, 300)}` : '';
      throw new Error(`${message}: ${response.status}${summary}`);
    }
  }
}
