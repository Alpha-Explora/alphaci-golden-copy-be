/**
 * Which earlier deploy a service may be put back on, and the rollback a
 * target is held on. Pure: no provider calls, no persistence.
 *
 * A rollback puts a deploy that already went live back in front of traffic.
 * It never builds anything, so only a deploy that succeeded can be chosen,
 * and never the one that is live right now.
 */

/** What ALPHACI keeps on a target's providerMetadata while it is rolled back. */
export interface DeployRollbackState {
  deployId: string;
  commitSha: string | null;
  commitMessage: string | null;
  reason: string;
  rolledBackBy: string;
  rolledBackAt: string;
  /** Vercel stops moving new production deploys onto the domain until resumed. */
  holdsNewDeploys: boolean;
}

export const DEPLOY_ROLLBACK_METADATA_KEY = 'rollback';

/** The subset of a provider deploy event the policy reads. */
export interface RollbackCandidateEvent {
  id: string;
  status: string;
  environment?: string | null;
  commitSha: string | null;
  commitMessage: string | null;
}

const WENT_LIVE = new Set([
  'ready',
  'live',
  'succeeded',
  'success',
  // Render's word for a deploy that was live and was then replaced.
  'deactivated',
  'superseded',
]);

export const ROLLBACK_REASON_MIN = 3;
export const ROLLBACK_REASON_MAX = 500;

/** The reason, trimmed, or a sentence saying what is wrong with it. */
export function rollbackReasonProblem(reason: unknown): string | null {
  if (typeof reason !== 'string') return 'Say why you are rolling back.';
  const trimmed = reason.trim();
  if (trimmed.length < ROLLBACK_REASON_MIN)
    return 'Say why you are rolling back.';
  if (trimmed.length > ROLLBACK_REASON_MAX) {
    return `Keep the reason under ${ROLLBACK_REASON_MAX} characters.`;
  }
  return null;
}

function wentLive(event: RollbackCandidateEvent): boolean {
  return WENT_LIVE.has(event.status.toLowerCase());
}

/**
 * The deploy serving traffic now: the rollback's own deploy while one holds
 * the target; otherwise Render's `live` deploy, or Vercel's newest production
 * deploy that went live (events arrive newest first).
 */
export function currentLiveDeployId(
  provider: string,
  events: ReadonlyArray<RollbackCandidateEvent>,
  rollback: Pick<DeployRollbackState, 'deployId'> | null,
): string | null {
  if (rollback) return rollback.deployId;
  if (provider === 'render') {
    return (
      events.find((event) => event.status.toLowerCase() === 'live')?.id ?? null
    );
  }
  return (
    events.find(
      (event) =>
        wentLive(event) && (event.environment ?? 'production') === 'production',
    )?.id ?? null
  );
}

/**
 * The chosen deploy, or the sentence that explains why it cannot be put back:
 * not among the recent deploys, never went live, not production on Vercel, or
 * already live.
 */
export function rollbackCandidate(input: {
  provider: string;
  deployId: string;
  events: ReadonlyArray<RollbackCandidateEvent>;
  rollback: Pick<DeployRollbackState, 'deployId'> | null;
}):
  | { ok: true; event: RollbackCandidateEvent }
  | { ok: false; reason: string } {
  const event = input.events.find(({ id }) => id === input.deployId);
  if (!event) {
    return {
      ok: false,
      reason: "That deploy is not among this service's recent deploys.",
    };
  }
  if (!wentLive(event)) {
    return {
      ok: false,
      reason: 'Only a deploy that went live can be put back.',
    };
  }
  if (
    input.provider === 'vercel' &&
    (event.environment ?? 'production') !== 'production'
  ) {
    return {
      ok: false,
      reason: 'Only a production deployment can be put back live on Vercel.',
    };
  }
  if (
    currentLiveDeployId(input.provider, input.events, input.rollback) ===
    event.id
  ) {
    return { ok: false, reason: 'That deploy is already live.' };
  }
  return { ok: true, event };
}

/** The rollback a target is held on, read back from its providerMetadata. */
export function readRollbackState(
  metadata: Record<string, unknown> | null | undefined,
): DeployRollbackState | null {
  const raw = metadata?.[DEPLOY_ROLLBACK_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.deployId !== 'string' || !value.deployId) return null;
  return {
    deployId: value.deployId,
    commitSha: typeof value.commitSha === 'string' ? value.commitSha : null,
    commitMessage:
      typeof value.commitMessage === 'string' ? value.commitMessage : null,
    reason: typeof value.reason === 'string' ? value.reason : '',
    rolledBackBy:
      typeof value.rolledBackBy === 'string' ? value.rolledBackBy : '',
    rolledBackAt:
      typeof value.rolledBackAt === 'string' ? value.rolledBackAt : '',
    holdsNewDeploys: value.holdsNewDeploys === true,
  };
}
