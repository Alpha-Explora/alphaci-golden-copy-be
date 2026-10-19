import { Injectable, Logger } from '@nestjs/common';
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
  ProviderRollbackInput,
  ProviderRollbackResult,
  ProviderDeploymentTarget,
  ProviderLogEntry,
  ProviderLogPage,
  ProviderLogQuery,
  ProviderLogsInput,
  ProviderProvisionResult,
  ProviderTargetStatus,
  ProviderTargetStatusInput,
  UpsertProviderEnvInput,
  AddProviderDomainInput,
  ProviderDomainInput,
  ProviderDomainResult,
} from '../../../application/ports/runtime-env-provider.client';
import type { DeploymentProvider } from '../../../core/deployment-provider-runtime.contract';
import type { DeploymentLogLine } from '../../../core/deployment-logs.types';
import {
  filterVercelLogLines,
  mapVercelBuildEventLine,
  mapVercelDeployHistory,
  mapVercelRuntimeLogLine,
  type VercelBuildEventEntry,
  type VercelDeploymentRow,
  type VercelRuntimeLogEntry,
} from './vercel-env.mapping';

const VERCEL_API_URL = 'https://api.vercel.com';

/** The requested name plus this many suffixed alternatives, at most. */
const VERCEL_PROJECT_NAME_ATTEMPTS = 5;

const VERCEL_PROJECT_NAME_MAX_LENGTH = 100;

interface CreateProjectAttempt {
  /** 1 asks for the requested name; each later attempt adds `-<n>`. */
  nameAttempt: number;
  linkGit: boolean;
}

/** Vercel's production lane. Every other branch is a scoped preview. */
const VERCEL_PRODUCTION_BRANCH = 'main';

/** Vercel's own scope label for a Protection Bypass for Automation secret. */
const VERCEL_AUTOMATION_BYPASS_SCOPE = 'automation-bypass';

/**
 * Recorded on every automation bypass secret this platform generates.
 *
 * Read back on the next call before generating a new one, so re-provisioning
 * or reinstalling a target's CI secrets reuses the same key rather than
 * minting another every time - Vercel does not cap how many bypass secrets a
 * project can hold, but nothing removes the old ones either. Also lets
 * whoever is reading the Vercel dashboard tell which secret is this
 * platform's.
 */
const VERCEL_AUTOMATION_BYPASS_NOTE = 'ALPHACI verify stage';

/**
 * Whether this target's variables will be scoped to a Git branch.
 *
 * Vercel accepts `gitBranch` on an environment variable only for a project
 * with a connected repository, and provisioning scopes every non-production
 * branch's variables that way so two branches cannot overwrite each other.
 * `main` takes the branchless production lane, so it is the one branch whose
 * variables an unlinked project can still hold.
 */
function needsBranchScopedEnv(branchName: string): boolean {
  return branchName.trim() !== VERCEL_PRODUCTION_BRANCH;
}

/**
 * Said to whoever has to fix it, in the place they will see it: on the
 * variable that could not be written.
 */
const UNLINKED_PROJECT_REASON =
  'This Vercel project has no connected Git repository, and a variable scoped ' +
  'to a branch needs one. Connect GitHub to the Vercel account the platform ' +
  'token belongs to (Vercel > Account Settings > Login Connections), install ' +
  'the Vercel GitHub App for the repository owner, link the project under its ' +
  'Settings > Git, then provision again.';

/**
 * The name to ask Vercel for on a given attempt: the requested name first, then
 * the same name with a numeric suffix, cut to stay inside Vercel's limit.
 */
function vercelProjectNameCandidate(requested: string, attempt: number) {
  if (attempt <= 1) {
    return requested;
  }

  const suffix = `-${String(attempt)}`;
  return `${requested.slice(0, VERCEL_PROJECT_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

/**
 * The part of Vercel's error envelope the client reasons about. Vercel sends
 * more than this; these are the fields that decide which remedy to name.
 */
interface VercelErrorBody {
  action?: string;
  code?: string;
  link?: string;
  message?: string;
  repo?: string;
  resource?: string;
}

@Injectable()
export class VercelEnvClient implements DeploymentProvider {
  readonly provider = 'vercel' as const;
  private readonly logger = new Logger(VercelEnvClient.name);

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
    const vercelOrgId = this.resolveVercelOrgId(input);
    let attempt: CreateProjectAttempt = {
      nameAttempt: 1,
      linkGit: Boolean(owner && repo),
    };

    for (;;) {
      const response = await fetch(
        this.withTargetScope(`${VERCEL_API_URL}/v11/projects`, input),
        {
          method: 'POST',
          headers: this.headers(input.token),
          body: JSON.stringify({
            name: vercelProjectNameCandidate(
              input.projectName,
              attempt.nameAttempt,
            ),
            ...(attempt.linkGit
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
      if (response.ok) {
        return this.createdTarget(
          response,
          input,
          vercelOrgId,
          attempt.linkGit,
        );
      }

      const body = await response.text().catch(() => '');
      const next = this.recoverCreateAttempt(
        input,
        attempt,
        response.status,
        body,
      );
      if (!next) {
        throw this.responseError(
          response.status,
          body,
          'Vercel project could not be created',
          this.gitLinkContext(input, body),
        );
      }
      attempt = next;
    }
  }

  /**
   * The attempt to make after a refusal the platform can get past on its own,
   * or null when the refusal has to reach the user.
   *
   * Two refusals are recoverable, and both used to fail the whole target — no
   * Vercel project, no secrets, no variables — while the rest of the project
   * reported itself provisioned:
   *
   * - The name is taken. Managed projects share one Vercel team across every
   *   customer, so `shop-frontend` from one GitHub owner blocks the same name
   *   from any other, and a project re-created after a delete meets its own
   *   leftover. The next free suffix is used instead; the alias variable and
   *   public URLs are derived from the name Vercel returns, so they follow it.
   * - Vercel will not link the repository. A CI-pushed project is deployed by
   *   the pipeline with the CLI, so the Git link is a convenience it does not
   *   need, and a repository created seconds earlier is not always visible to
   *   Vercel's GitHub integration yet. The project is created unlinked rather
   *   than not at all. A Git-connected project deploys through that link, so
   *   for it the refusal still stands.
   *
   *   That fallback holds only while the target's variables are branchless.
   *   Once they are scoped to a branch the link stops being a convenience:
   *   Vercel rejects a branch-scoped variable on an unlinked project, so
   *   creating it unlinked bought a project that exists, holds none of its
   *   variables, and never reaches the step that writes its CI secrets. The
   *   refusal is reported instead, naming the branch that needs the link.
   */
  private recoverCreateAttempt(
    input: CreateProviderTargetInput,
    attempt: CreateProjectAttempt,
    status: number,
    body: string,
  ): CreateProjectAttempt | null {
    const error = this.parseErrorBody(body);

    if (
      attempt.linkGit &&
      input.deploymentStrategy === 'vercel_ci_pushed' &&
      error &&
      this.isGitLinkRefusal(error)
    ) {
      if (needsBranchScopedEnv(input.branchName)) {
        this.logger.warn(
          `Vercel could not link ${input.repoFullName}, and ${input.projectName} tracks ${input.branchName}, whose variables are scoped to that branch. An unlinked project cannot hold them, so it is not created.`,
        );
        return null;
      }

      this.logger.warn(
        `Vercel could not link ${input.repoFullName}; creating ${input.projectName} without a Git link. The pipeline deploys it with the CLI.`,
      );
      return { ...attempt, linkGit: false };
    }

    const nameTaken = status === 409 || error?.code === 'conflict';
    if (nameTaken && attempt.nameAttempt < VERCEL_PROJECT_NAME_ATTEMPTS) {
      const nextAttempt = attempt.nameAttempt + 1;
      this.logger.warn(
        `Vercel project name ${vercelProjectNameCandidate(input.projectName, attempt.nameAttempt)} is taken; trying ${vercelProjectNameCandidate(input.projectName, nextAttempt)}.`,
      );
      return { ...attempt, nameAttempt: nextAttempt };
    }

    return null;
  }

  private async createdTarget(
    response: Response,
    input: CreateProviderTargetInput,
    vercelOrgId: string,
    gitConnected: boolean,
  ): Promise<ProviderDeploymentTarget> {
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
        gitConnected,
      },
    };
  }

  async upsertEnvironmentVariables(
    input: UpsertProviderEnvInput,
  ): Promise<ProviderProvisionResult> {
    /*
     * An unlinked project cannot hold these, and no amount of retrying the
     * write changes that — the remedy is on the Vercel account.
     *
     * Reported as failed variables rather than thrown, because throwing here
     * abandoned the rest of provisioning: the caller never reached the step
     * that writes VERCEL_*_TOKEN, VERCEL_*_ORG_ID, VERCEL_*_PROJECT_ID and
     * VERCEL_ALIAS to the repository, so one refused variable also cost the
     * pipeline every secret it deploys with. The reason travels with each key
     * to the env metadata and the setup panel.
     */
    if (
      input.lane === 'preview' &&
      input.gitBranch &&
      input.gitConnected === false
    ) {
      this.logger.warn(
        `Vercel project ${input.targetId} has no Git link, so ${String(input.vars.length)} variable(s) scoped to ${input.gitBranch} were not written.`,
      );
      return {
        provisioned: [],
        failed: input.vars.map((variable) => ({
          key: variable.key,
          status: 'failed' as const,
          errorSummary: UNLINKED_PROJECT_REASON,
        })),
      };
    }

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
      this.withInputScope(
        `${VERCEL_API_URL}/v9/projects/${input.targetId}`,
        input,
      ),
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

  /**
   * A Protection Bypass for Automation secret for this project, reusing one
   * already there before minting another.
   *
   * Scoped exactly the way {@link getTargetStatus} scopes a call against an
   * existing target - `withInputScope`, so a BYO connection's team travels on
   * the input the same way it does for status/history/log lookups, rather
   * than silently falling back to the ALPHACI-managed team `withScope` reads
   * from config.
   */
  async ensureAutomationBypassSecret(
    input: ProviderTargetStatusInput,
  ): Promise<string> {
    const before = await this.protectionBypassEntries(input);
    const existing = this.preferredAutomationBypassSecret(before);
    if (existing) {
      return existing;
    }

    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v1/projects/${encodeURIComponent(input.targetId)}/protection-bypass`,
        input,
      ),
      {
        method: 'PATCH',
        headers: this.headers(input.token),
        body: JSON.stringify({
          generate: { note: VERCEL_AUTOMATION_BYPASS_NOTE },
        }),
      },
    );
    await this.assertOk(
      response,
      'Vercel automation bypass secret could not be created',
    );
    const payload = (await response.json()) as {
      protectionBypass?: Record<string, unknown>;
    };
    // The PATCH response is the PROJECT's full bypass-secret set, not just
    // what this call added, so the new key is whichever one was not in the
    // snapshot read a moment ago.
    const created = Object.keys(payload.protectionBypass ?? {}).find(
      (key) => !(key in before),
    );
    if (!created) {
      throw new Error(
        'Vercel accepted the automation bypass request but did not return a new secret',
      );
    }

    return created;
  }

  /**
   * Turns off Vercel Authentication on this project, so its preview
   * deployments (where uat and every other non-production branch land) open
   * without a Vercel sign-in. Vercel's default, Standard Protection, puts
   * every preview behind vercel.com/sso-api: QA Studio cannot frame it and a
   * QA tester without a seat on the Vercel team cannot open it at all.
   *
   * Only Vercel Authentication (`ssoProtection`) is cleared. Password
   * protection and trusted IPs are paid features someone chose on purpose,
   * and the automation bypass secrets stay. `unchanged` when it was already
   * off, so a reinstall writes nothing.
   */
  async ensurePublicPreviews(
    input: ProviderTargetStatusInput,
  ): Promise<'disabled' | 'unchanged'> {
    const url = this.withInputScope(
      `${VERCEL_API_URL}/v9/projects/${encodeURIComponent(input.targetId)}`,
      input,
    );
    const current = await fetch(url, { headers: this.headers(input.token) });
    await this.assertOk(current, 'Vercel project could not be loaded');
    const project = (await current.json()) as { ssoProtection?: unknown };
    if (project.ssoProtection === null || project.ssoProtection === undefined) {
      return 'unchanged';
    }

    const response = await fetch(url, {
      method: 'PATCH',
      headers: this.headers(input.token),
      body: JSON.stringify({ ssoProtection: null }),
    });
    await this.assertOk(
      response,
      'Vercel Authentication could not be turned off for this project',
    );
    return 'disabled';
  }

  /** Every scope: 'automation-bypass' entry, keyed by the secret itself. */
  private async protectionBypassEntries(
    input: ProviderTargetStatusInput,
  ): Promise<Record<string, { scope?: string; note?: string }>> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v9/projects/${encodeURIComponent(input.targetId)}`,
        input,
      ),
      { headers: this.headers(input.token) },
    );
    await this.assertOk(response, 'Vercel project could not be loaded');
    const payload = (await response.json()) as {
      protectionBypass?: Record<string, { scope?: string; note?: string }>;
    };

    return payload.protectionBypass ?? {};
  }

  /**
   * Which already-provisioned bypass secret to reuse, or null when none
   * exists yet.
   *
   * Prefers the one this platform generated (its note matches), so a project
   * with other bypass secrets - hand-created, or made for a different tool -
   * is not handed one of those instead. Falls back to any automation-bypass
   * secret when none carries that note, because Vercel does not require a
   * note at all and an un-noted one this platform made earlier is still this
   * platform's to reuse.
   */
  private preferredAutomationBypassSecret(
    entries: Record<string, { scope?: string; note?: string }>,
  ): string | null {
    const automationSecrets = Object.entries(entries).filter(
      ([, meta]) => meta.scope === VERCEL_AUTOMATION_BYPASS_SCOPE,
    );
    if (automationSecrets.length === 0) {
      return null;
    }

    const ownNote = automationSecrets.find(
      ([, meta]) => meta.note === VERCEL_AUTOMATION_BYPASS_NOTE,
    );

    return (ownNote ?? automationSecrets[0])![0];
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
    await this.assertOk(response, 'Vercel deploy history could not be loaded');
    const payload = (await response.json()) as {
      deployments?: VercelDeploymentRow[];
    };

    return mapVercelDeployHistory(payload.deployments);
  }

  /**
   * Instant Rollback: points the production domains at an earlier production
   * deployment, without building anything. Vercel then stops assigning new
   * production deploys to the domains until a deployment is promoted again,
   * which is what `resumeDeploys` does.
   */
  async rollbackDeploy(
    input: ProviderRollbackInput,
  ): Promise<ProviderRollbackResult> {
    const response = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v9/projects/${encodeURIComponent(input.targetId)}/rollback/${encodeURIComponent(input.deployId)}`,
        input,
      ),
      { method: 'POST', headers: this.headers(input.token) },
    );
    await this.assertOk(
      response,
      'Vercel could not roll back to that deployment',
    );
    return {
      deployId: input.deployId,
      status: 'rolling_back',
      holdsNewDeploys: true,
    };
  }

  /**
   * Ends a rollback: promotes the newest production deployment that is ready,
   * which puts it on the domains and lets new production deploys through.
   */
  async resumeDeploys(
    input: ProviderTargetStatusInput,
  ): Promise<{ deployId: string | null }> {
    const listed = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v6/deployments?projectId=${encodeURIComponent(input.targetId)}&target=production&state=READY&limit=1`,
        input,
      ),
      { headers: this.headers(input.token) },
    );
    await this.assertOk(
      listed,
      'Vercel production deployments could not be loaded',
    );
    const payload = (await listed.json()) as {
      deployments?: Array<{ uid?: string }>;
    };
    const deployId = payload.deployments?.[0]?.uid ?? null;
    if (!deployId) return { deployId: null };
    const promoted = await fetch(
      this.withInputScope(
        `${VERCEL_API_URL}/v10/projects/${encodeURIComponent(input.targetId)}/promote/${encodeURIComponent(deployId)}`,
        input,
      ),
      { method: 'POST', headers: this.headers(input.token) },
    );
    await this.assertOk(
      promoted,
      'Vercel could not put the newest deployment back live',
    );
    return { deployId };
  }

  async queryLogs(input: ProviderLogQuery): Promise<ProviderLogPage> {
    const deploymentsUrl = this.withInputScope(
      `${VERCEL_API_URL}/v6/deployments?projectId=${encodeURIComponent(input.targetId)}&limit=1`,
      input,
    );
    // Plain fetch + typed 429, not fetchWithRetry: log reads are polled (via
    // the shared poller), and retrying inside a tick multiplies requests while
    // the token is already rate limited. The shared cooldown is the retry.
    const depResponse = await fetch(deploymentsUrl, {
      headers: this.headers(input.token),
    });
    throwIfRateLimited(depResponse, 'Vercel');
    await this.assertOk(depResponse, 'Vercel deployments could not be loaded');
    const depData = (await depResponse.json()) as {
      deployments?: Array<{ uid?: string }>;
    };
    const latestDeploymentId = depData.deployments?.[0]?.uid;
    if (!latestDeploymentId) {
      return { logs: [], hasMore: false, next: null };
    }

    // Vercel exposes build and runtime lines as two separate endpoints with
    // no combined query; a `type` filter asking only for 'build' reads the
    // build events, anything else (including no filter at all) reads the
    // runtime log stream. Unlike Render, there is no single call that can
    // return both in one page.
    const types = input.type ?? [];
    const wantsBuildOnly =
      types.length > 0 && types.every((t) => t === 'build');
    const rawLines = wantsBuildOnly
      ? await this.fetchVercelBuildLogLines(input, latestDeploymentId)
      : await this.fetchVercelRuntimeLogLines(input, latestDeploymentId);

    // Unlike Render's /v1/logs, neither Vercel endpoint this client calls
    // returns newest-first: the build-events endpoint's own `direction`
    // parameter defaults to 'forward' (oldest-first) and this client never
    // overrides it, and the runtime-logs endpoint is an undirected
    // "stream of logs" with no direction/order parameter at all — i.e.
    // already emission order. So, unlike mapRenderLogsPage, there is no
    // newest-first payload to reverse before this stable sort; the sort
    // below is purely the same out-of-order-line guard Render's mapping
    // has, and ties correctly fall back to the order Vercel sent them in.
    const logs = filterVercelLogLines(rawLines, {
      ...(input.level ? { level: input.level } : {}),
      ...(input.text ? { text: input.text } : {}),
    }).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    // Vercel's runtime-logs and build-events endpoints are each a single
    // bounded fetch (limit=100) with no cursor of their own, so there is
    // nothing further to page through from this client's point of view.
    return { logs, hasMore: false, next: null };
  }

  /**
   * Thin compatibility wrapper: queryLogs owns the real Vercel mapping, this
   * just flattens its richer page shape back to the pre-parity return type
   * for any caller still on the old operation.
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

  private async fetchVercelRuntimeLogLines(
    input: ProviderLogQuery,
    deploymentId: string,
  ): Promise<DeploymentLogLine[]> {
    const logsUrl = this.withInputScope(
      `${VERCEL_API_URL}/v1/projects/${encodeURIComponent(
        input.targetId,
      )}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs?limit=100`,
      input,
    );
    const logsResponse = await fetch(logsUrl, {
      headers: this.headers(input.token),
    });
    throwIfRateLimited(logsResponse, 'Vercel');
    await this.assertOk(
      logsResponse,
      'Vercel runtime logs could not be loaded',
    );
    const logsData = (await logsResponse.json()) as
      | VercelRuntimeLogEntry[]
      | { logs?: VercelRuntimeLogEntry[] };
    const logsList = Array.isArray(logsData) ? logsData : (logsData.logs ?? []);

    return logsList.map((line, index) => mapVercelRuntimeLogLine(line, index));
  }

  private async fetchVercelBuildLogLines(
    input: ProviderLogQuery,
    deploymentId: string,
  ): Promise<DeploymentLogLine[]> {
    const eventsUrl = this.withInputScope(
      `${VERCEL_API_URL}/v2/deployments/${encodeURIComponent(deploymentId)}/events?limit=100`,
      input,
    );
    const response = await fetch(eventsUrl, {
      headers: this.headers(input.token),
    });
    throwIfRateLimited(response, 'Vercel');
    await this.assertOk(response, 'Vercel build logs could not be loaded');
    const events = (await response.json()) as VercelBuildEventEntry[];

    return events
      .map((event, index) => mapVercelBuildEventLine(event, index))
      .filter((line): line is DeploymentLogLine => line !== null);
  }

  async addDomain(
    input: AddProviderDomainInput,
  ): Promise<ProviderDomainResult> {
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
  async verifyDomain(
    input: ProviderDomainInput,
  ): Promise<ProviderDomainResult> {
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
      throw this.responseError(response.status, body, message);
    }
  }

  private responseError(
    status: number,
    body: string,
    message: string,
    context?: string,
  ): Error {
    const actionableError = this.toActionableError(body);
    if (actionableError) {
      return new Error(`${actionableError}${context ?? ''}`);
    }

    const summary = body ? ` ${body.slice(0, 300)}` : '';
    return new Error(`${message}: ${status}${summary}`);
  }

  /**
   * Why a link refusal is fatal for this target rather than something the
   * platform works around, appended to the remedy the refusal already names.
   *
   * Only said when it is true: a target on the production branch is still
   * created unlinked, and telling its owner about branch scoping would be
   * describing a problem they do not have.
   */
  private gitLinkContext(
    input: CreateProviderTargetInput,
    body: string,
  ): string | undefined {
    const error = this.parseErrorBody(body);
    if (
      !error ||
      !this.isGitLinkRefusal(error) ||
      !needsBranchScopedEnv(input.branchName)
    ) {
      return undefined;
    }

    return (
      ` This project tracks ${input.branchName}, whose variables are scoped to that ` +
      'branch, and Vercel accepts a branch-scoped variable only on a project with a ' +
      'connected repository — so it was not created unlinked.'
    );
  }

  private parseErrorBody(body: string): VercelErrorBody | null {
    if (!body) {
      return null;
    }

    try {
      const payload = JSON.parse(body) as { error?: VercelErrorBody };
      return payload.error ?? null;
    } catch {
      return null;
    }
  }

  private toActionableError(body: string): string | null {
    const error = this.parseErrorBody(body);
    if (!error) {
      return null;
    }

    return this.gitLinkMessage(error) ?? this.forbiddenMessage(error);
  }

  /**
   * Vercel refusing to LINK the repository, which is not the same as refusing
   * to create the project.
   *
   * There is more than one of these and they read nothing alike. The GitHub App
   * not being installed for the owner says "install the GitHub integration";
   * the Vercel account having no GitHub login says "You need to add a Login
   * Connection to your GitHub account first" — observed on a real create, where
   * only the first was recognised, so a project that needed no Git link at all
   * failed for want of one.
   *
   * Matched on what they have in common — the link is what failed — rather than
   * on one phrasing, because the next variant will read differently again.
   */
  private isGitLinkRefusal(error: VercelErrorBody): boolean {
    const message = error.message ?? '';
    return (
      error.action === 'Install GitHub App' ||
      error.action === 'Add a Login Connection' ||
      /failed to link|install the github integration|login connection/i.test(
        message,
      )
    );
  }

  private gitLinkMessage(error: VercelErrorBody): string | null {
    if (!this.isGitLinkRefusal(error)) {
      return null;
    }

    const repo = error.repo?.trim() || 'the GitHub repository';
    const needsLoginConnection =
      error.action === 'Add a Login Connection' ||
      /login connection/i.test(error.message ?? '');

    // Named from Vercel's own `action`, because the two have different
    // remedies in different places and sending someone to the wrong one costs
    // them the afternoon.
    const remedy = needsLoginConnection
      ? 'Connect a GitHub account to the Vercel account the platform token belongs to (Vercel → Account Settings → Login Connections), then retry.'
      : 'Install the Vercel GitHub App for that GitHub owner and grant it access to the repository, then retry.';

    return `Vercel would not link ${repo}. ${remedy}`;
  }

  /**
   * A 403 means the token authenticated and was then refused, so neither
   * "check the token" nor Vercel's raw JSON is a useful thing to show.
   *
   * Exactly three things produce it for a write, and the response cannot tell
   * them apart - so all three are named rather than guessed between. Billing
   * leads because a restricted account keeps answering reads while refusing
   * writes, which presents as a permissions bug and sends the reader to the
   * wrong place.
   *
   * The message stays well inside the 500 characters the provisioning
   * sanitizer keeps, so it reaches the UI whole rather than cut mid-sentence.
   */
  private forbiddenMessage(error: VercelErrorBody): string | null {
    if (error.code !== 'forbidden') {
      return null;
    }

    const operation =
      error.action && error.resource
        ? `${error.action} a ${error.resource}`
        : 'complete that request';

    return (
      `Vercel refused to ${operation} (403). The token is valid but is not allowed to act ` +
      'on the team ALPHACI_VERCEL_TEAM_ID names. Check, in this order: the Vercel account ' +
      'has no overdue invoice, because billing restrictions block writes while reads keep ' +
      "working; the token's owner is an Owner or Admin of that team; and the token's scope " +
      'covers that team. Then retry.'
    );
  }
}
