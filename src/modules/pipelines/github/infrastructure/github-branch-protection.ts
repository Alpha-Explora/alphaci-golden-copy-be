import type {
  GithubBranchProtectionOutcome,
  GithubPullRequestProtectionOptions,
} from '#kernel/ports/github.port';
import type { GithubHttp } from './github-http';

/**
 * Pull-request-only branch protection that never loosens what a branch
 * already has.
 *
 * The rule (see PERSONA_WORKFLOW_SPEC.md, "Branch protection"): a pull request
 * is required before anything lands on dev, uat or main, force pushes and
 * deletion are blocked, and enforce_admins stays off so an organisation admin
 * keeps an escape hatch. Zero approvals are required: ALPHACI merges pull
 * requests on a person's behalf and a required approval nobody can give would
 * block every merge.
 *
 * The PUT /protection endpoint REPLACES the whole rule, so the payload is built
 * from the current rule: required status checks (and the app that must report
 * them), restrictions, an existing approval count, code-owner review and the
 * other switches are carried over. Only the pull-request requirement, force
 * push and deletion are forced.
 */

interface ProtectionToggle {
  enabled?: boolean;
}

interface NamedActor {
  login?: string;
  slug?: string;
}

interface ProtectionActors {
  users?: NamedActor[];
  teams?: NamedActor[];
  apps?: NamedActor[];
}

/** The slice of GET /branches/{branch}/protection this module reads. */
export interface GithubProtectionRow {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: Array<{ context: string; app_id?: number | null }>;
  } | null;
  enforce_admins?: ProtectionToggle | null;
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    required_approving_review_count?: number;
    require_last_push_approval?: boolean;
    dismissal_restrictions?: ProtectionActors;
    bypass_pull_request_allowances?: ProtectionActors;
  } | null;
  restrictions?: ProtectionActors | null;
  required_linear_history?: ProtectionToggle;
  allow_force_pushes?: ProtectionToggle;
  allow_deletions?: ProtectionToggle;
  block_creations?: ProtectionToggle;
  required_conversation_resolution?: ProtectionToggle;
  lock_branch?: ProtectionToggle;
  allow_fork_syncing?: ProtectionToggle;
}

function actorPayload(
  actors: ProtectionActors | null | undefined,
): { users: string[]; teams: string[]; apps: string[] } | undefined {
  if (!actors) return undefined;
  return {
    users: (actors.users ?? []).flatMap((u) => (u.login ? [u.login] : [])),
    teams: (actors.teams ?? []).flatMap((t) => (t.slug ? [t.slug] : [])),
    apps: (actors.apps ?? []).flatMap((a) => (a.slug ? [a.slug] : [])),
  };
}

/** True when the rule already satisfies every part of the policy. */
export function satisfiesPullRequestPolicy(
  existing: GithubProtectionRow | null,
): boolean {
  return (
    existing !== null &&
    existing.required_pull_request_reviews != null &&
    existing.allow_force_pushes?.enabled !== true &&
    existing.allow_deletions?.enabled !== true
  );
}

export function buildPullRequestProtectionPayload(
  existing: GithubProtectionRow | null,
  seedStatusChecks: readonly string[] = [],
): Record<string, unknown> {
  // Checks, keeping the app each one must come from. `contexts` is the legacy
  // spelling of the same list and cannot be sent together with `checks`.
  const kept = new Map<string, number | null>();
  const current = existing?.required_status_checks;
  for (const check of current?.checks ?? []) {
    kept.set(check.context, check.app_id ?? null);
  }
  for (const context of current?.contexts ?? []) {
    if (!kept.has(context)) kept.set(context, null);
  }
  if (kept.size === 0 && current == null) {
    for (const context of seedStatusChecks) kept.set(context, null);
  }
  const requiredStatusChecks =
    kept.size > 0 || current != null
      ? {
          strict: current?.strict ?? false,
          checks: [...kept].map(([context, appId]) => ({
            context,
            // -1 means "any app"; omitting app_id is rejected by some plans.
            app_id: appId ?? -1,
          })),
        }
      : null;

  const reviews = existing?.required_pull_request_reviews;
  const requiredReviews: Record<string, unknown> = {
    dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? true,
    require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
    required_approving_review_count:
      reviews?.required_approving_review_count ?? 0,
  };
  if (reviews?.require_last_push_approval !== undefined) {
    requiredReviews['require_last_push_approval'] =
      reviews.require_last_push_approval;
  }
  const dismissal = actorPayload(reviews?.dismissal_restrictions);
  if (dismissal) requiredReviews['dismissal_restrictions'] = dismissal;
  const bypass = actorPayload(reviews?.bypass_pull_request_allowances);
  if (bypass) requiredReviews['bypass_pull_request_allowances'] = bypass;

  const payload: Record<string, unknown> = {
    required_status_checks: requiredStatusChecks,
    // Off for a new rule so an org admin keeps an escape hatch; an admin who
    // deliberately turned it on is not overridden.
    enforce_admins: existing?.enforce_admins?.enabled === true,
    required_pull_request_reviews: requiredReviews,
    restrictions: actorPayload(existing?.restrictions) ?? null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const carried: Array<[string, ProtectionToggle | undefined]> = [
    ['required_linear_history', existing?.required_linear_history],
    ['block_creations', existing?.block_creations],
    [
      'required_conversation_resolution',
      existing?.required_conversation_resolution,
    ],
    ['lock_branch', existing?.lock_branch],
    ['allow_fork_syncing', existing?.allow_fork_syncing],
  ];
  for (const [key, toggle] of carried) {
    if (toggle?.enabled !== undefined) payload[key] = toggle.enabled;
  }
  return payload;
}

function failure(
  status: number,
  body: string,
  repoFullName: string,
  branch: string,
): GithubBranchProtectionOutcome {
  let detail = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) detail = parsed.message.slice(0, 200);
  } catch {
    // Not JSON: keep the raw excerpt.
  }
  const hint =
    status === 401
      ? 'the GitHub credential was rejected'
      : status === 403 || status === 404
        ? `the credential lacks admin permission on ${repoFullName} (the GitHub App needs Administration: write)`
        : 'GitHub refused the rule';
  return {
    status: 'failed',
    error: `HTTP ${String(status)} on ${branch}: ${hint}. ${detail}`.trim(),
  };
}

export async function ensurePullRequestProtection(
  http: GithubHttp,
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
  options: GithubPullRequestProtectionOptions = {},
): Promise<GithubBranchProtectionOutcome> {
  const repoFullName = `${owner}/${repo}`;
  const base = `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`;
  const headers = http.workspaceHeaders(accessToken);

  try {
    // A 404 from /protection cannot tell "no rule" from "no branch", so the
    // branch is checked first.
    const branchResponse = await http.fetchWithRetry(base, { headers });
    if (branchResponse.status === 404) {
      return { status: 'missing' };
    }
    if (!branchResponse.ok) {
      return failure(
        branchResponse.status,
        await branchResponse.text(),
        repoFullName,
        branch,
      );
    }

    const current = await http.fetchWithRetry(`${base}/protection`, {
      headers,
    });
    let existing: GithubProtectionRow | null = null;
    if (current.status !== 404) {
      if (!current.ok) {
        return failure(
          current.status,
          await current.text(),
          repoFullName,
          branch,
        );
      }
      existing = (await current.json()) as GithubProtectionRow;
    }

    if (satisfiesPullRequestPolicy(existing)) {
      return { status: 'unchanged' };
    }

    const put = await http.fetchWithRetry(`${base}/protection`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildPullRequestProtectionPayload(
          existing,
          options.seedStatusChecks ?? [],
        ),
      ),
    });
    if (!put.ok) {
      return failure(put.status, await put.text(), repoFullName, branch);
    }
    return { status: 'applied' };
  } catch (error) {
    // Never include the token: only the message of the transport error.
    return {
      status: 'failed',
      error: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
