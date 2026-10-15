/** A stored assignment: every host port was allocated by AlphaCI on the machine. */
export interface AssignmentConfig {
  ports: Array<{
    slot: 'frontend' | 'backend';
    hostPort: number;
    containerPort: number;
  }>;
  health: Array<{ slot: 'frontend' | 'backend'; path: string | null }>;
  ingress: { mode: 'direct' | 'configured'; publicUrl: string | null };
}
/**
 * What a client asks for. Host ports are chosen by the server inside the
 * assignment transaction; a `hostPort` sent by an older client is ignored.
 */
export interface AssignmentRequestConfig {
  ports: Array<{
    slot: 'frontend' | 'backend';
    containerPort: number;
    hostPort?: number;
  }>;
  health: AssignmentConfig['health'];
  ingress: AssignmentConfig['ingress'];
}
export interface OnpremAssignmentPort {
  /** `machineId` omitted: the workspace's only healthy machine is used. */
  assignProvisionedEnvironment(
    projectId: string,
    environmentId: string,
    userId: string,
    input: {
      machineId?: string;
      requestId: string;
      config: AssignmentRequestConfig;
    },
  ): Promise<{ assignmentId: string }>;
  /**
   * Assign an on-prem environment nobody configured to the workspace's only
   * healthy machine with default ports and health checks. Returns null when
   * that is not possible without a person's choice; never throws for that.
   */
  ensureAutomaticAssignment(
    projectId: string,
    environmentId: string,
    userId: string,
  ): Promise<{ assignmentId: string } | null>;
}
export const ONPREM_ASSIGNMENT = Symbol('OnpremAssignmentPort');
