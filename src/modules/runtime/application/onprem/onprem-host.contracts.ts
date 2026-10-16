import type { ReadinessCheck } from './onprem-readiness.service';

export interface MachineSummary {
  id: string;
  workspaceId: string;
  name: string;
  platform: 'windows' | 'ubuntu';
  agentVersion: string | null;
  lastSeenAt: string | null;
  status:
    | 'enrollment_pending'
    | 'connected'
    | 'prerequisites_failed'
    | 'offline'
    | 'revoked';
  checks: ReadinessCheck[];
}
export interface EnrollmentInput {
  name: string;
  platform: 'windows' | 'ubuntu';
  requestId: string;
  replacesMachineId?: string;
}
export interface MachineCheckIn {
  agentVersion: string;
  checks: ReadinessCheck[];
}
/** The machine's observed state of one tunnel-mode assignment. */
export interface TunnelReportInput {
  assignmentId: string;
  status: 'starting' | 'running' | 'unavailable' | 'failed';
  message: string;
  publicUrl: string | null;
}
export interface MachineHeartbeat extends MachineCheckIn {
  /** Every tunnel-mode assignment on the machine; absent from older agents. */
  tunnels?: TunnelReportInput[];
}
/** A tunnel-mode assignment the machine must keep an HTTPS tunnel open for. */
export interface TunnelBinding {
  assignmentId: string;
  projectId: string;
  environmentId: string;
  hostPort: number;
}
export interface HeartbeatReply {
  /** Host ports reserved on the machine. */
  ports: number[];
  tunnels: TunnelBinding[];
}
export interface InstallerRelease {
  version: string;
  url: string;
  sha256: string;
}
export interface EnrollmentReceipt {
  apiUrl: string;
  id: string;
  code: string;
  expiresAt: string;
  replacesMachineId: string | null;
  installer: InstallerRelease;
}
export interface EnrollmentResult {
  machine: MachineSummary;
  credential: string;
  apiUrl: string;
  trustKeys: Record<string, string>;
}
