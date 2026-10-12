/** What the team-level QA overview needs to know about one Project (delivery project) that hierarchy owns. */
export interface DeliveryProjectOverviewFacts {
  /** ACTIVE members of kind `developer` (hierarchy.delivery_project_members). */
  developers: number;
  /** ACTIVE members of kind `qa`. */
  qa: number;
  /** The viewer's own ACTIVE membership kind in this Project; null when they have none. */
  viewerKind: 'developer' | 'qa' | null;
  /**
   * Non-archived repositories of the Project that are linked to a provisioned
   * (AlphaCI) project, oldest first: the only ones a Project run covers and
   * the only ones that can be promoted.
   */
  repositories: Array<{ projectId: string; repoFullName: string }>;
}

/**
 * Batched, read-only facts the projects context needs for its team overview.
 * Membership and repositories live in hierarchy.* (identity-access), so the
 * projects context asks through this port instead of reading those tables.
 */
export interface DeliveryProjectOverviewQuery {
  /**
   * One batched read for all `deliveryProjectIds` (never one call per Project).
   * Every requested id is present in the result, with zeros / null / [] for a
   * Project that has no members or repositories.
   */
  getOverviewFacts(
    deliveryProjectIds: readonly string[],
    viewerUserId: string,
  ): Promise<Map<string, DeliveryProjectOverviewFacts>>;
}

export const DELIVERY_PROJECT_OVERVIEW_QUERY = Symbol(
  'DeliveryProjectOverviewQuery',
);
