import type { ProviderDeployEvent } from '../../../application/ports/runtime-env-provider.client';
import {
  normalizeLogLevel,
  type DeploymentLogLine,
} from '../../../core/deployment-logs.types';

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
  creator?: {
    username?: string;
    githubLogin?: string;
  };
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
    // The GitHub login first, as Vercel's own deployment page shows it; the
    // Vercel username covers a creator with no GitHub account linked.
    createdBy:
      deployment.creator?.githubLogin ?? deployment.creator?.username ?? null,
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

export interface VercelRuntimeLogEntry {
  timestamp?: number;
  text?: string;
  message?: string;
  type?: string;
  level?: string;
  id?: string;
  requestId?: string;
}

export interface VercelBuildEventEntry {
  id?: string;
  created?: number;
  type?: string;
  payload?: { text?: string };
}

function vercelLineId(
  prefix: string,
  timestamp: string,
  index: number,
  providedId?: string,
): string {
  return providedId?.trim() || `${prefix}-${timestamp}-${index}`;
}

/** Vercel's runtime-log `type` is a stream name, not a level word; only these two carry one. */
function vercelRuntimeLogLevel(
  entry: VercelRuntimeLogEntry,
): string | undefined {
  if (entry.level) return entry.level;
  if (entry.type === 'err') return 'error';
  if (entry.type === 'warning') return 'warn';
  return undefined;
}

/**
 * Vercel's runtime-logs entries carry their own `type` ('stdout'/'stderr'/
 * a lambda lifecycle event) rather than a level word; only `err`/`error`
 * clearly means error, so anything else routes through normalizeLogLevel to
 * land on the shared vocabulary rather than inventing a second one here.
 */
export function mapVercelRuntimeLogLine(
  entry: VercelRuntimeLogEntry,
  index: number,
): DeploymentLogLine {
  const timestamp = entry.timestamp
    ? new Date(Number(entry.timestamp)).toISOString()
    : new Date().toISOString();

  return {
    id: vercelLineId('runtime', timestamp, index, entry.id ?? entry.requestId),
    timestamp,
    message: entry.text || entry.message || '',
    level: normalizeLogLevel(vercelRuntimeLogLevel(entry)),
    type: 'app',
    instance: null,
    labels: entry.type ? { type: entry.type } : {},
  };
}

/** A build event with no `payload.text` is a structural/lifecycle event, not a log line. */
export function mapVercelBuildEventLine(
  event: VercelBuildEventEntry,
  index: number,
): DeploymentLogLine | null {
  if (typeof event.payload?.text !== 'string') {
    return null;
  }
  const timestamp = event.created
    ? new Date(event.created).toISOString()
    : new Date().toISOString();

  return {
    id: vercelLineId('build', timestamp, index, event.id),
    timestamp,
    message: event.payload.text,
    level: normalizeLogLevel(event.type === 'stderr' ? 'error' : undefined),
    type: 'build',
    instance: null,
    labels: event.type ? { stream: event.type } : {},
  };
}

/**
 * Vercel's log APIs don't take `level`/`text` as server-side query params the
 * way Render's do, so those two filters are applied here instead — the page
 * shape the caller gets back is identical either way.
 */
export function filterVercelLogLines(
  lines: readonly DeploymentLogLine[],
  filters: { level?: readonly string[]; text?: string },
): DeploymentLogLine[] {
  let result = [...lines];
  if (filters.level?.length) {
    const wanted = new Set(filters.level.map((level) => level.toLowerCase()));
    result = result.filter((line) => wanted.has(line.level));
  }
  if (filters.text?.trim()) {
    const needle = filters.text.trim().toLowerCase();
    result = result.filter((line) =>
      line.message.toLowerCase().includes(needle),
    );
  }

  return result;
}
