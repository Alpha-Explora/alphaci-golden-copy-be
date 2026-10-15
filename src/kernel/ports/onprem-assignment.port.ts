export interface AssignmentConfig {
  ports: Array<{
    slot: 'frontend' | 'backend';
    hostPort: number;
    containerPort: number;
  }>;
  health: Array<{ slot: 'frontend' | 'backend'; path: string | null }>;
  ingress: { mode: 'direct' | 'configured'; publicUrl: string | null };
}
export interface OnpremAssignmentPort {
  assignProvisionedEnvironment(
    projectId: string,
    environmentId: string,
    userId: string,
    input: { machineId: string; requestId: string; config: AssignmentConfig },
  ): Promise<{ assignmentId: string }>;
}
export const ONPREM_ASSIGNMENT = Symbol('OnpremAssignmentPort');
