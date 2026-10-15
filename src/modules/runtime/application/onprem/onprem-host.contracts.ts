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
