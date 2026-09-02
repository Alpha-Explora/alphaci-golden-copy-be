import type { ProviderDeployEvent } from '../../../application/ports/runtime-env-provider.client';

export type VercelDeploymentRow = {
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
};

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

export function mapVercelDeployEvent(
  deployment: VercelDeploymentRow,
): ProviderDeployEvent | null {
  if (!deployment.uid) {
    return null;
  }

  return {
    id: deployment.uid,
    status: deployment.readyState ?? deployment.state ?? 'unknown',
    createdAt: deployment.createdAt
      ? new Date(deployment.createdAt).toISOString()
      : new Date().toISOString(),
    readyAt: deployment.ready ? new Date(deployment.ready).toISOString() : null,
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
  };
}

export function mapVercelDeployHistory(
  deployments: VercelDeploymentRow[] | undefined,
): ProviderDeployEvent[] {
  return (deployments ?? [])
    .map(mapVercelDeployEvent)
    .filter((event): event is ProviderDeployEvent => event !== null);
}
