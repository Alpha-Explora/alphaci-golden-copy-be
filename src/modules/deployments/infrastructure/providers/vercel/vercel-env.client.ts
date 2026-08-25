import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../../../config/app.config';
import { fetchWithRetry } from '../core/fetch-with-retry';
import type {
  CreateProviderTargetInput,
  DeleteProviderEnvInput,
  DeleteProviderTargetInput,
  DeleteProviderTargetResult,
  ProviderAccountSummary,
  ProviderDeployEvent,
  ProviderDeploymentTarget,
  ProviderLogEntry,
  ProviderLogsInput,
  ProviderProvisionResult,
  ProviderTargetStatus,
  ProviderTargetStatusInput,
  UpsertProviderEnvInput,
  AddProviderDomainInput,
  ProviderDomainInput,
  ProviderDomainResult,
} from '../core/runtime-env-provider.client';
import type { DeploymentProvider } from '../../../core/deployment-provider-runtime.contract';

const VERCEL_API_URL = 'https://api.vercel.com';

@Injectable()
export class VercelEnvClient implements DeploymentProvider {
  readonly provider = 'vercel' as const;

  constructor(private readonly configService?: ConfigService) {}

  async validateConnection(token: string): Promise<ProviderAccountSummary> {
    const response = await fetch(this.withScope(`${VERCEL_API_URL}/v2/user`), {
      headers: this.headers(token),
    });
    await this.assertOk(response, 'Vercel connection validation failed');
    const payload = (await response.json()) as {
      user?: { uid?: string; username?: string; name?: string };
    };
    const accountId = payload.user?.uid ?? 'vercel-account';

    return {
      id: accountId,
      name: payload.user?.name ?? payload.user?.username ?? 'Vercel account',
      metadata: {
        accountType: 'user',
        orgId: accountId,
      },
    };
  }

  async validateTeamAccess(
    token: string,
    teamId: string,
  ): Promise<{ id: string; slug?: string; name?: string }> {
    const response = await fetch(`${VERCEL_API_URL}/v2/teams/${teamId}`, {
      headers: this.headers(token),
    });
    await this.assertOk(response, 'Vercel team access validation failed');
    const payload = (await response.json()) as {
      id?: string;
      slug?: string;
      name?: string;
    };
    if (!payload.id) {
      throw new Error('Vercel team validation returned an invalid response');
    }

    return {
      id: payload.id,
      ...(payload.slug ? { slug: payload.slug } : {}),
      ...(payload.name ? { name: payload.name } : {}),
    };
  }

  async listTargets(token: string): Promise<ProviderDeploymentTarget[]> {
    const response = await fetch(
      this.withScope(`${VERCEL_API_URL}/v9/projects`),
      {
        headers: this.headers(token),
      },
    );
    await this.assertOk(response, 'Vercel projects could not be loaded');
    const payload = (await response.json()) as {
      projects?: Array<{ id?: string; name?: string }>;
    };

    return (payload.projects ?? [])
      .filter((project): project is { id: string; name: string } =>
        Boolean(project.id && project.name),
      )
      .map((project) => ({
        id: project.id,
        name: project.name,
        provider: this.provider,
      }));
  }

  async createTarget(
    input: CreateProviderTargetInput,
  ): Promise<ProviderDeploymentTarget> {
    const [owner, repo] = input.repoFullName.split('/');
    const rootDirectory = this.normalizeRootDirectory(input.rootDirectory);
    const shouldConnectGit = Boolean(owner && repo);
    const vercelOrgId = this.resolveVercelOrgId(input);
    const response = await fetch(
      this.withTargetScope(`${VERCEL_API_URL}/v11/projects`, input),
      {
        method: 'POST',
        headers: this.headers(input.token),
        body: JSON.stringify({
          name: input.projectName,
          ...(shouldConnectGit
            ? {
                gitRepository: {
                  type: 'github',
                  repo: input.repoFullName,
                },
              }
            : {}),
          rootDirectory,
          buildCommand: input.buildCommand,
        }),
      },
    );
    await this.assertOk(response, 'Vercel project could not be created');
    const payload = (await response.json()) as { id?: string; name?: string };
    if (!payload.id || !payload.name) {
      throw new Error('Vercel project creation returned an invalid response');
    }

    return {
      id: payload.id,
      name: payload.name,
      provider: this.provider,
      metadata: {
        deploymentStrategy: input.deploymentStrategy ?? 'vercel_git_connected',
        vercelProjectId: payload.id,
        vercelOrgId,
        ...(input.vercelTeamId ? { vercelTeamId: input.vercelTeamId } : {}),
        ...(input.vercelTeamSlug
          ? { vercelTeamSlug: input.vercelTeamSlug }
          : {}),
        gitConnected: shouldConnectGit,
      },
    };
  }

  async upsertEnvironmentVariables(
    input: UpsertProviderEnvInput,
  ): Promise<ProviderProvisionResult> {
    for (const variable of input.vars) {
      const response = await fetch(
        this.withScope(
          `${VERCEL_API_URL}/v10/projects/${input.targetId}/env?upsert=true`,
        ),
        {
          method: 'POST',
          headers: this.headers(input.token),
          body: JSON.stringify({
            key: variable.key,
            value: variable.value,
            type: 'sensitive',
            target: [input.lane],
            // Vercel's upsert key is (key, target, gitBranch). Sending the
            // branch is what gives each branch its own set of values —
            // without it every preview branch shares one record, which is how
            // the old test/uat pair silently overwrote each other.
            ...(input.lane === 'preview' && input.gitBranch
              ? { gitBranch: input.gitBranch }
              : {}),
          }),
        },
      );
      await this.assertOk(response, 'Vercel env var could not be updated');
    }

    return {
      provisioned: input.vars.map((variable) => ({
        key: variable.key,
        status: 'provisioned',
      })),
      failed: [],
    };
  }

  async deleteEnvironmentVariable(
    input: DeleteProviderEnvInput,
  ): Promise<{ key: string; status: 'removed' }> {
    const listResponse = await fetch(
      this.withScope(
        `${VERCEL_API_URL}/v9/projects/${input.targetId}/env?key=${encodeURIComponent(input.key)}&target=${input.lane}`,
      ),
      {
        headers: this.headers(input.token),
      },
    );
    await this.assertOk(listResponse, 'Vercel env vars could not be loaded');
    const payload = (await listResponse.json()) as {
      envs?: Array<{
        id?: string;
        key?: string;
        target?: string[];
        gitBranch?: string | null;
      }>;
    };
    // Match the branch as well as the key.
    //
    // Filtered here rather than by query parameter so the branch is compared
    // against what Vercel actually returned. Matching on key alone deleted the
    // first preview record Vercel happened to list — which is how removing one
    // branch's variable used to remove another branch's.
    const envId = (payload.envs ?? []).find(
      (env) =>
        env.key === input.key &&
        (input.lane === 'production'
          ? !env.gitBranch
          : env.gitBranch === input.gitBranch),
    )?.id;
    if (!envId) {
      return { key: input.key, status: 'removed' };
    }

    const deleteResponse = await fetch(
      this.withScope(
        `${VERCEL_API_URL}/v9/projects/${input.targetId}/env/${envId}`,
      ),
      {
        method: 'DELETE',
        headers: this.headers(input.token),
      },
    );
    await this.assertOk(deleteResponse, 'Vercel env var could not be deleted');

    return { key: input.key, status: 'removed' };
  }

  async getTargetStatus(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderTargetStatus> {
    const response = await fetch(
      this.withInputScope(`${VERCEL_API_URL}/v9/projects/${input.targetId}`, input),
      { headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return { exists: false };
    }
    await this.assertOk(response, 'Vercel project status could not be loaded');
    const payload = (await response.json()) as {
      id?: string;
      name?: string;
      latestDeployments?: Array<{ url?: string }>;
    };

    const url = payload.latestDeployments?.[0]?.url;

    return {
      exists: true,
      ...(url !== undefined ? { url } : {}),
    };
  }

  async deleteTarget(
    input: DeleteProviderTargetInput,
  ): Promise<DeleteProviderTargetResult> {
    const response = await fetch(
      this.withScope(`${VERCEL_API_URL}/v9/projects/${input.targetId}`),
      { method: 'DELETE', headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return { deleted: true };
    }
    await this.assertOk(response, 'Vercel project could not be deleted');

    return { deleted: true };
  }

  async getDeployHistory(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderDeployEvent[]> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v6/deployments?projectId=${encodeURIComponent(input.targetId)}&limit=20`,
        input,
      ),
      { headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return [];
    }
    await this.assertOk(
      response,
      'Vercel deploy history could not be loaded',
    );
    const payload = (await response.json()) as {
      deployments?: Array<{
        uid?: string;
        url?: string;
        target?: string | null;
        inspectorUrl?: string | null;
        state?: string;
        readyState?: string;
        source?: string;
        createdAt?: number;
        ready?: number;
        meta?: {
          githubCommitSha?: string;
          githubCommitMessage?: string;
          githubCommitRef?: string;
          githubPrId?: string;
        };
      }>;
    };

    return (payload.deployments ?? [])
      .filter((deployment): deployment is typeof deployment & { uid: string } =>
        Boolean(deployment.uid),
      )
      .map((deployment) => ({
        id: deployment.uid,
        status: deployment.readyState ?? deployment.state ?? 'unknown',
        createdAt: deployment.createdAt
          ? new Date(deployment.createdAt).toISOString()
          : new Date().toISOString(),
        readyAt: deployment.ready
          ? new Date(deployment.ready).toISOString()
          : null,
        commitSha: deployment.meta?.githubCommitSha ?? null,
        commitMessage: deployment.meta?.githubCommitMessage ?? null,
        trigger: deployment.source ?? null,
        deploymentUrl: normalizeDeploymentUrl(deployment.url),
        // Anything that is not the production lane is a preview as far as
        // Vercel's own UI is concerned — including the custom environments
        // it reports as `staging` — so only an explicit 'production' maps
        // to production.
        environment:
          deployment.target === 'production'
            ? ('production' as const)
            : ('preview' as const),
        pullRequestNumber: parsePullRequestNumber(deployment.meta?.githubPrId),
        commitRef: deployment.meta?.githubCommitRef ?? null,
        inspectorUrl: deployment.inspectorUrl ?? null,
      }));
  }

  async getLogs(input: ProviderLogsInput): Promise<ProviderLogEntry[]> {
    const deploymentsUrl = this.withInputScope(
      `${VERCEL_API_URL}/v6/deployments?projectId=${encodeURIComponent(input.targetId)}&limit=1`,
      input,
    );
    const depResponse = await fetchWithRetry(
      deploymentsUrl,
      { headers: this.headers(input.token) },
      'Vercel',
    );
    await this.assertOk(depResponse, 'Vercel deployments could not be loaded');
    const depData = (await depResponse.json()) as {
      deployments?: Array<{ uid?: string }>;
    };
    const latestDeploymentId = depData.deployments?.[0]?.uid;
    if (!latestDeploymentId) {
      return [];
    }

    if (input.type === 'build') {
      return this.getBuildLogs(input, latestDeploymentId);
    }

    const logsUrl = this.withInputScope(
      `${VERCEL_API_URL}/v1/projects/${encodeURIComponent(
        input.targetId,
      )}/deployments/${encodeURIComponent(latestDeploymentId)}/runtime-logs?limit=100`,
      input,
    );
    const logsResponse = await fetchWithRetry(
      logsUrl,
      { headers: this.headers(input.token) },
      'Vercel',
    );
    await this.assertOk(logsResponse, 'Vercel runtime logs could not be loaded');
    interface VercelRuntimeLogEntry {
      timestamp: number;
      text?: string;
      message?: string;
      type?: string;
      level?: string;
    }
    const logsData = (await logsResponse.json()) as
      | VercelRuntimeLogEntry[]
      | { logs?: VercelRuntimeLogEntry[] };
    const logsList = Array.isArray(logsData)
      ? logsData
      : (logsData.logs ?? []);

    return logsList.map((l) => ({
      timestamp: l.timestamp
        ? new Date(Number(l.timestamp)).toISOString()
        : new Date().toISOString(),
      message: l.text || l.message || '',
      level:
        l.type === 'err' || l.level === 'error'
          ? 'error'
          : l.type === 'warning' || l.level === 'warn'
            ? 'warn'
            : 'info',
    }));
  }

  private async getBuildLogs(
    input: ProviderLogsInput,
    deploymentId: string,
  ): Promise<ProviderLogEntry[]> {
    const eventsUrl = this.withInputScope(
      `${VERCEL_API_URL}/v2/deployments/${encodeURIComponent(deploymentId)}/events?limit=100`,
      input,
    );
    const response = await fetchWithRetry(
      eventsUrl,
      { headers: this.headers(input.token) },
      'Vercel',
    );
    await this.assertOk(response, 'Vercel build logs could not be loaded');
    interface VercelBuildEvent {
      created?: number;
      type?: string;
      payload?: { text?: string };
    }
    const events = (await response.json()) as VercelBuildEvent[];

    return events
      .filter((event) => typeof event.payload?.text === 'string')
      .map((event) => ({
        timestamp: event.created
          ? new Date(event.created).toISOString()
          : new Date().toISOString(),
        message: event.payload?.text ?? '',
        level: event.type === 'stderr' ? 'error' : 'info',
      }));
  }

  async addDomain(input: AddProviderDomainInput): Promise<ProviderDomainResult> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v10/projects/${encodeURIComponent(input.targetId)}/domains`,
        input,
      ),
      {
        method: 'POST',
        headers: this.headers(input.token),
        body: JSON.stringify({
          name: input.hostname,
          // Vercel pins a domain to a branch with this field, which is what
          // lets a branch carry its own hostname the way it carries its own
          // environment variables. Omitted entirely for the production domain.
          ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
        }),
      },
    );

    if (response.status === 409) {
      throw new Error(
        `${input.hostname} is already assigned to a Vercel project. Remove it there first, or use a different hostname.`,
      );
    }
    await this.assertOk(response, 'Vercel domain could not be added');

    return this.toDomainResult(await response.json());
  }

  async listDomains(
    input: ProviderTargetStatusInput,
  ): Promise<ProviderDomainResult[]> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v9/projects/${encodeURIComponent(input.targetId)}/domains`,
        input,
      ),
      { headers: this.headers(input.token) },
    );
    if (response.status === 404) {
      return [];
    }
    await this.assertOk(response, 'Vercel domains could not be loaded');

    const payload = (await response.json()) as { domains?: unknown[] };
    return (payload.domains ?? []).map((domain) => this.toDomainResult(domain));
  }

  /**
   * Asks Vercel to re-check the challenge, then asks separately whether DNS
   * actually points at it.
   *
   * Two questions, not one: a domain can be verified as owned while still
   * pointing somewhere else, and reporting only the first would tell someone
   * their domain is ready while it serves nothing.
   */
  async verifyDomain(input: ProviderDomainInput): Promise<ProviderDomainResult> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v10/projects/${encodeURIComponent(input.targetId)}/domains/${encodeURIComponent(input.hostname)}/verify`,
        input,
      ),
      { method: 'POST', headers: this.headers(input.token) },
    );
    await this.assertOk(response, 'Vercel domain could not be verified');

    const result = this.toDomainResult(await response.json());
    return { ...result, misconfigured: await this.domainMisconfigured(input) };
  }

  async removeDomain(input: ProviderDomainInput): Promise<{ removed: true }> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v9/projects/${encodeURIComponent(input.targetId)}/domains/${encodeURIComponent(input.hostname)}`,
        input,
      ),
      { method: 'DELETE', headers: this.headers(input.token) },
    );
    // Already gone is the outcome the caller wanted.
    if (response.status === 404) {
      return { removed: true };
    }
    await this.assertOk(response, 'Vercel domain could not be removed');

    return { removed: true };
  }

  /**
   * Whether DNS currently points at Vercel. Null rather than a throw when the
   * check itself fails: not knowing is different from being misconfigured, and
   * the domain record should not be marked broken on a transient error.
   */
  private async domainMisconfigured(
    input: ProviderDomainInput,
  ): Promise<boolean | null> {
    try {
      const response = await fetch(
        this.withInputScope(
          `${VERCEL_API_URL}/v6/domains/${encodeURIComponent(input.hostname)}/config`,
          input,
        ),
        { headers: this.headers(input.token) },
      );
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { misconfigured?: boolean };
      return payload.misconfigured ?? null;
    } catch {
      return null;
    }
  }

  private toDomainResult(payload: unknown): ProviderDomainResult {
    const domain = payload as {
      name?: string;
      apexName?: string;
      verified?: boolean;
      verification?: Array<{
        type?: string;
        domain?: string;
        value?: string;
        reason?: string;
      }>;
    };

    return {
      hostname: domain.name ?? '',
      apexDomain: domain.apexName ?? null,
      verified: domain.verified === true,
      // Passed through as Vercel gave them. These are the DNS records the
      // reader has to create, so inventing or reshaping them would be
      // inventing instructions.
      verification: (domain.verification ?? []).map((challenge) => ({
        type: challenge.type ?? '',
        domain: challenge.domain ?? '',
        value: challenge.value ?? '',
        reason: challenge.reason ?? '',
      })),
      misconfigured: null,
    };
  }

  private withInputScope(
    url: string,
    input: ProviderTargetStatusInput,
  ): string {
    const teamId = input.vercelTeamId?.trim();
    const slug = input.vercelTeamSlug?.trim();
    if (!teamId && !slug) {
      return this.withScope(url);
    }

    const scopedUrl = new URL(url);
    if (teamId) {
      scopedUrl.searchParams.set('teamId', teamId);
    } else if (slug) {
      scopedUrl.searchParams.set('slug', slug);
    }

    return scopedUrl.toString();
  }

  private withScope(url: string): string {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    const teamId =
      config?.envProvisioning.flowciManaged.vercelTeamId?.trim() ?? '';
    const slug =
      config?.envProvisioning.flowciManaged.vercelTeamSlug?.trim() ?? '';
    if (!teamId && !slug) {
      return url;
    }

    const scopedUrl = new URL(url);
    if (teamId) {
      scopedUrl.searchParams.set('teamId', teamId);
    } else {
      scopedUrl.searchParams.set('slug', slug);
    }

    return scopedUrl.toString();
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private withTargetScope(
    url: string,
    input: CreateProviderTargetInput,
  ): string {
    const teamId = input.vercelTeamId?.trim();
    const slug = input.vercelTeamSlug?.trim();
    if (teamId || slug) {
      const scopedUrl = new URL(url);
      if (teamId) {
        scopedUrl.searchParams.set('teamId', teamId);
      } else if (slug) {
        scopedUrl.searchParams.set('slug', slug);
      }

      return scopedUrl.toString();
    }

    if (input.deploymentStrategy === 'vercel_ci_pushed') {
      return url;
    }

    return this.withScope(url);
  }

  private normalizeRootDirectory(
    rootDirectory: string | null | undefined,
  ): string | undefined {
    const normalized = rootDirectory?.trim().replace(/\\/g, '/');
    if (!normalized || normalized === '.') {
      return undefined;
    }

    const withoutLeadingDotSlash = normalized.replace(/^(\.\/)+/, '');
    if (
      !withoutLeadingDotSlash ||
      withoutLeadingDotSlash.startsWith('/') ||
      withoutLeadingDotSlash.includes('..')
    ) {
      return undefined;
    }

    return withoutLeadingDotSlash;
  }

  private resolveVercelOrgId(input: CreateProviderTargetInput): string {
    if (input.vercelOrgId?.trim()) {
      return input.vercelOrgId.trim();
    }

    if (input.vercelTeamId?.trim()) {
      return input.vercelTeamId.trim();
    }

    if (input.deploymentStrategy === 'vercel_ci_pushed') {
      throw new Error(
        'Vercel org id is required when creating CI-pushed deployment targets',
      );
    }

    return 'vercel-account';
  }

  private async assertOk(response: Response, message: string): Promise<void> {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const actionableError = this.toActionableError(body);
      if (actionableError) {
        throw new Error(actionableError);
      }

      const summary = body ? ` ${body.slice(0, 300)}` : '';
      throw new Error(`${message}: ${response.status}${summary}`);
    }
  }

  private toActionableError(body: string): string | null {
    if (!body) {
      return null;
    }

    let payload: {
      error?: {
        action?: string;
        code?: string;
        link?: string;
        message?: string;
        repo?: string;
      };
    };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      return null;
    }

    const error = payload.error;
    if (
      error?.action !== 'Install GitHub App' ||
      !error.message?.includes('install the GitHub integration')
    ) {
      return null;
    }

    const repo = error.repo?.trim() || 'the GitHub repository';
    return (
      `Vercel GitHub integration is not installed or does not have access to ${repo}. ` +
      'Install the Vercel GitHub App for that GitHub owner and grant repository access, then retry.'
    );
  }
}

/**
 * Vercel reports a deployment's hostname without a scheme
 * (`my-app-abc123-team.vercel.app`), so it has to be prefixed before it is
 * usable as a link. Tolerates an already-absolute URL in case Vercel ever
 * starts returning one.
 */
function normalizeDeploymentUrl(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) {
    return null;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * `meta.githubPrId` arrives as a string. Anything that is not a positive
 * integer is treated as absent rather than surfaced as NaN.
 */
function parsePullRequestNumber(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
