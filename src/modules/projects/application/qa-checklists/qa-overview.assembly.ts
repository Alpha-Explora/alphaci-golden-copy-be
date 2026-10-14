import type { DeliveryProjectOverviewFacts } from '#kernel/ports/delivery-project-overview.port';
import { bucketMyQaItem } from '../../domain/qa-my-items.rules';
import type {
  QaProjectRunHeadline,
  QaRunItemFact,
} from '../../infrastructure/qa-project-runs.repository';
import { parseDeliveryEntries } from '../../domain/project-delivery.rules';
import type { ProjectIterationRow } from '../../infrastructure/project-iterations.repository';
import { QA_OPEN_DEFECT_STATUSES } from '../qa-runs/qa-runs.contracts';
import type {
  OverviewDefectCounts,
  OverviewIteration,
  OverviewLatestRun,
  OverviewProjectCounts,
  OverviewPromotion,
  QaProgress,
  RequirementsOverviewGroup,
} from './qa-requirements.contracts';

/**
 * Pure assembly of the per-Project fields the team overview adds to each
 * group (latestRun, counts, promotion, viewerMembership). Everything is read
 * in batches by QaRequirementsService.overview; this turns the rows of ONE
 * Project into the contract. No Nest, no I/O.
 */

/** One requirement item of a Project's NON-archived requirements. */
export interface OverviewRequirementItem {
  id: string;
  progress: QaProgress;
}

export interface ProjectOverviewInput {
  run: QaProjectRunHeadline | undefined;
  /** Items of `run`, [] when there is no run. */
  runItems: readonly QaRunItemFact[];
  /** Items of the Project's non-archived requirements (the My QA items feed's population). */
  items: readonly OverviewRequirementItem[];
  facts: DeliveryProjectOverviewFacts | undefined;
  /** The Project's current Iteration: its stored delivery state is the promotion state. */
  iteration: ProjectIterationRow | undefined;
}

export function summarizeLatestRun(
  run: QaProjectRunHeadline | undefined,
): OverviewLatestRun | null {
  if (!run) {
    return null;
  }
  const signedOff = run.status === 'signed_off';
  return {
    id: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    verdict: signedOff ? run.verdict : null,
    signedOffAt: signedOff ? run.signedAt : null,
    signedOffBy: signedOff ? run.signedByLogin || null : null,
  };
}

/** Items that are failed, blocked or returned to dev, by defect severity (null severity is unrated). */
export function countOpenDefects(
  runItems: readonly QaRunItemFact[],
): OverviewDefectCounts {
  const counts: OverviewDefectCounts = {
    blocker: 0,
    major: 0,
    minor: 0,
    unrated: 0,
  };
  for (const item of runItems) {
    if (QA_OPEN_DEFECT_STATUSES.includes(item.status)) {
      counts[item.defectSeverity ?? 'unrated'] += 1;
    }
  }
  return counts;
}

/**
 * Size of the `readyForQa` bucket of the My QA items feed, by the feed's own
 * rule (bucketMyQaItem). The run item of a requirement item is the one whose
 * source_item_id points at it; no run item (or no run) leaves the status null.
 */
export function countReadyForQa(
  items: readonly OverviewRequirementItem[],
  runItems: readonly QaRunItemFact[],
): number {
  const statusBySource = new Map<string, QaRunItemFact['status']>();
  for (const runItem of runItems) {
    if (runItem.sourceItemId) {
      statusBySource.set(runItem.sourceItemId, runItem.status);
    }
  }
  let ready = 0;
  for (const item of items) {
    if (
      bucketMyQaItem(item.progress, statusBySource.get(item.id) ?? null) ===
      'readyForQa'
    ) {
      ready += 1;
    }
  }
  return ready;
}

/**
 * Promotion read from the STORED per-repository delivery state of the
 * Project's current Iteration (`delivery_json`), not from audit rows: it is
 * the same state PO Studio and the Merge to main gate use, and it survives
 * audit recording being off.
 */
export function summarizePromotion(
  run: QaProjectRunHeadline | undefined,
  facts: DeliveryProjectOverviewFacts | undefined,
  iteration: ProjectIterationRow | undefined,
): OverviewPromotion | null {
  if (run?.status !== 'signed_off') {
    return null;
  }
  const repositories = facts?.repositories ?? [];
  const known = new Set(repositories.map((repository) => repository.projectId));
  const entries = parseDeliveryEntries(iteration?.delivery_json).filter(
    (entry) => iteration?.status === 'delivered' || known.has(entry.projectId),
  );
  let lastMergedAt: string | null = null;
  for (const entry of entries) {
    // One fixed-width ISO format, so string order is time order.
    if (entry.at && (lastMergedAt === null || entry.at > lastMergedAt)) {
      lastMergedAt = entry.at;
    }
  }
  return {
    mergedRepositories: entries.length,
    totalRepositories: Math.max(repositories.length, entries.length),
    lastMergedAt,
  };
}

/** The Project's current Iteration as the overview shows it. */
export function summarizeIteration(
  iteration: ProjectIterationRow | undefined,
): OverviewIteration | null {
  return iteration
    ? {
        number: iteration.number,
        status: iteration.status,
        deliveredAt: iteration.delivered_at
          ? new Date(iteration.delivered_at).toISOString()
          : null,
      }
    : null;
}

export function buildProjectOverview(
  input: ProjectOverviewInput,
): Pick<
  RequirementsOverviewGroup,
  'latestRun' | 'counts' | 'promotion' | 'iteration' | 'viewerMembership'
> {
  const counts: OverviewProjectCounts = {
    readyForQa: countReadyForQa(input.items, input.runItems),
    openDefects: countOpenDefects(input.runItems),
    members: {
      developer: input.facts?.developers ?? 0,
      qa: input.facts?.qa ?? 0,
    },
  };
  return {
    latestRun: summarizeLatestRun(input.run),
    counts,
    promotion: summarizePromotion(input.run, input.facts, input.iteration),
    iteration: summarizeIteration(input.iteration),
    viewerMembership: input.facts?.viewerKind ?? null,
  };
}
