/** A stored assignment: every host port was allocated by AlphaCI on the machine. */
export interface AssignmentConfig {
  ports: Array<{
    slot: 'frontend' | 'backend';
    hostPort: number;
    containerPort: number;
  }>;
  health: Array<{ slot: 'frontend' | 'backend'; path: string | null }>;
  ingress: AssignmentIngress;
}
/**
 * How users reach the environment. `tunnel` has the machine create an HTTPS
 * address; its publicUrl is reported by the machine, never sent by a client.
 */
export interface AssignmentIngress {
  mode: 'direct' | 'configured' | 'tunnel';
  publicUrl: string | null;
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
  ingress: AssignmentIngress;
}
/** The machine's latest state for a tunnel-mode assignment. */
export type TunnelStatus = 'starting' | 'running' | 'unavailable' | 'failed';
/** What the API shows: `waiting` until a fresh report arrives. */
export interface TunnelReport {
  status: TunnelStatus | 'waiting';
  /** The reported HTTPS address, only while its report is fresh. */
  publicUrl: string | null;
  message: string;
  reportedAt: string | null;
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
  /**
   * The address users reach an on-prem environment at: the machine's reported
   * tunnel address or the configured public URL. Null when there is none yet.
   */
  publicAddress(
    projectId: string,
    environmentId: string,
    slot: string,
  ): Promise<string | null>;
}
export const ONPREM_ASSIGNMENT = Symbol('OnpremAssignmentPort');
