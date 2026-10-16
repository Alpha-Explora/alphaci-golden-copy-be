import type { ReadinessCheck } from './onprem-readiness.service';
import type { TunnelReportInput } from '../../domain/onprem-tunnel';

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
/** A heartbeat as the machine sent it: tunnel entries are validated by the service. */
export interface MachineHeartbeatInput extends MachineCheckIn {
  /** Every tunnel-mode assignment on the machine; absent from older agents. */
  tunnels?: unknown[];
}
/** A heartbeat with its tunnel entries validated. */
export interface MachineHeartbeat extends MachineCheckIn {
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
