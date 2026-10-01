/**
 * Identity Access deletes Projects (delivery projects); other contexts own data
 * keyed by a Project id they cannot hold a foreign key to (check-schema-ownership
 * refuses new cross-context FKs). This narrow port lets the deletion flow ask
 * those owners to remove it, without Identity Access knowing what it is. Same
 * shape as WorkspaceDataCleanupPort.
 */
export interface DeliveryProjectDataCleanupPort {
  /**
   * Removes data owned by the implementing context for a deleted Project.
   * Idempotent. History that carries its own snapshot (QA runs) is kept.
   */
  purgeDeliveryProject(deliveryProjectId: string): Promise<{ removed: number }>;
}

export const DELIVERY_PROJECT_DATA_CLEANUP = Symbol(
  'DeliveryProjectDataCleanupPort',
);
