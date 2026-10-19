import type {
  AssignmentIngress,
  TunnelReport,
  TunnelStatus,
} from '#kernel/ports/onprem-assignment.port';

/** A machine reports every 30 seconds; a report older than this is stale. */
export const TUNNEL_REPORT_WINDOW = `90 seconds`;

/**
 * An AlphaCI quick-tunnel address: word-hyphen-word hostnames under
 * trycloudflare.com. The hyphen rules out api.trycloudflare.com and IP hosts.
 */
export const QUICK_TUNNEL_ADDRESS =
  /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly TunnelStatus[] = [
  'starting',
  'running',
  'unavailable',
  'failed',
];
const MAX_MESSAGE = 300;

export const WAITING_FOR_TUNNEL =
  'Waiting for the machine to report its address.';
export const REJECTED_TUNNEL_ADDRESS =
  'The machine reported an address that is not an AlphaCI quick-tunnel address, so it was not recorded.';
export const UNKNOWN_TUNNEL_STATE =
  'The machine reported a tunnel state that AlphaCI does not recognize.';
export const RUNNING_WITHOUT_ADDRESS =
  'The machine reported a running tunnel without its address, so it was not recorded.';

/** A tunnel report as the machine sends it, validated. */
export interface TunnelReportInput {
  assignmentId: string;
  status: TunnelStatus;
  message: string;
  publicUrl: string | null;
}

/** The part of a binding's tunnel columns that the API presents. */
export interface TunnelReportRow {
  status: TunnelStatus | null;
  url: string | null;
  message: string | null;
  reportedAt: Date | null;
  fresh: boolean;
}

/** The API view of an assignment's latest tunnel report. */
export function tunnelReport(row: TunnelReportRow): TunnelReport {
  const reportedAt = row.reportedAt?.toISOString() ?? null;
  if (!row.status || !row.fresh)
    return {
      status: 'waiting',
      publicUrl: null,
      message: WAITING_FOR_TUNNEL,
      reportedAt,
    };
  return {
    status: row.status,
    publicUrl: row.status === 'running' ? row.url : null,
    message: row.message || WAITING_FOR_TUNNEL,
    reportedAt,
  };
}

/**
 * One tunnel entry from a heartbeat. An entry that names an assignment but has
 * an unacceptable state or address is recorded as failed with the reason, so
 * readiness can show it; only an entry without a valid assignment ID is dropped.
 */
export function parseTunnelReport(entry: unknown): TunnelReportInput | null {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry as Record<string, unknown>;
  const assignmentId = value['assignmentId'];
  if (typeof assignmentId !== 'string' || !UUID.test(assignmentId)) return null;
  const message =
    typeof value['message'] === 'string'
      ? value['message']
          .split(String.fromCharCode(0))
          .join('')
          .slice(0, MAX_MESSAGE)
      : '';
  const rejected = (reason: string): TunnelReportInput => ({
    assignmentId,
    status: 'failed',
    message: reason,
    publicUrl: null,
  });
  const status = value['status'];
  if (typeof status !== 'string' || !STATUSES.includes(status as TunnelStatus))
    return rejected(UNKNOWN_TUNNEL_STATE);
  const url = value['publicUrl'];
  if (
    url !== null &&
    (typeof url !== 'string' || !QUICK_TUNNEL_ADDRESS.test(url))
  )
    return rejected(REJECTED_TUNNEL_ADDRESS);
  if (status === 'running' && url === null)
    return rejected(RUNNING_WITHOUT_ADDRESS);
  if (status !== 'running' && url !== null)
    return rejected(REJECTED_TUNNEL_ADDRESS);
  return {
    assignmentId,
    status: status as TunnelStatus,
    message,
    publicUrl: url,
  };
}

/** The port a tunnel serves: the frontend when there is one, else the first. */
export function servedSlot(
  ports: ReadonlyArray<{ slot: string; hostPort: number }>,
): string | null {
  return (
    (ports.find((item) => item.slot === 'frontend') ?? ports[0])?.slot ?? null
  );
}

/**
 * The address an assignment is reached at: its fresh tunnel address in tunnel
 * mode, the configured public URL otherwise.
 */
export function effectivePublicAddress(
  ingress: AssignmentIngress,
  tunnel: TunnelReport | null,
): string | null {
  if (ingress.mode === 'tunnel') return tunnel?.publicUrl ?? null;
  return ingress.mode === 'configured' ? ingress.publicUrl : null;
}

/** The host port the tunnel serves. */
export function tunnelPort(
  ports: ReadonlyArray<{ slot: string; hostPort: number }>,
): number | null {
  const slot = servedSlot(ports);
  return ports.find((item) => item.slot === slot)?.hostPort ?? null;
}

/**
 * Whether production may be handed to the machine: a fresh, running tunnel
 * with its address. Other environments do not wait for a tunnel.
 */
export function tunnelReady(row: TunnelReportRow): boolean {
  return row.status === 'running' && row.url !== null && row.fresh;
}

/** The agent release that reports tunnels; older agents never do. */
export const TUNNEL_AGENT_VERSION = '0.3.0';
export const UPDATE_AGENT_MESSAGE =
  'Update the agent on this machine to use automatic HTTPS.';

/** Whether an agent version reports tunnels: dotted numbers, compared part by part. */
export function agentSupportsTunnels(version: string | null): boolean {
  return agentAtLeast(version, TUNNEL_AGENT_VERSION);
}

/** Whether a reported agent version is `minimum` or newer; malformed never is. */
export function agentAtLeast(version: string | null, minimum: string): boolean {
  if (!version) return false;
  const have = version.split('.').map((part) => Number(part));
  if (
    have.length !== 3 ||
    have.some((part) => !Number.isInteger(part) || part < 0)
  )
    return false;
  const required = minimum.split('.').map((part) => Number(part));
  for (let index = 0; index < required.length; index++) {
    const reported = have[index] ?? 0;
    const wanted = required[index] ?? 0;
    if (reported !== wanted) return reported > wanted;
  }
  return true;
}

/**
 * Readiness of the ingress for an assignment. Production needs an HTTPS
 * address: a configured one, or the tunnel's once the machine reports it.
 */
export function ingressReadiness(
  ingress: AssignmentIngress,
  tunnel: TunnelReport | null,
  production: boolean,
  agentVersion: string | null,
): { status: 'passed' | 'failed' | 'unverified'; message: string } {
  if (ingress.mode === 'tunnel') {
    if (tunnel?.publicUrl)
      return {
        status: 'unverified',
        message: `Automatic HTTPS address reported by the machine: ${tunnel.publicUrl}. Open it from a client device to confirm it reaches the application.`,
      };
    if (!production)
      return {
        status: 'failed',
        message: agentSupportsTunnels(agentVersion)
          ? (tunnel?.message ?? WAITING_FOR_TUNNEL)
          : UPDATE_AGENT_MESSAGE,
      };
    // Production is not handed to the machine until its tunnel runs.
    const detail = !agentSupportsTunnels(agentVersion)
      ? UPDATE_AGENT_MESSAGE
      : tunnel && tunnel.status !== 'waiting'
        ? tunnel.message
        : 'Production is not deployed until the machine reports one.';
    return {
      status: 'failed',
      message: `Waiting for the HTTPS address. ${detail}`,
    };
  }
  if (production)
    return ingress.mode === 'configured' &&
      ingress.publicUrl?.startsWith('https://')
      ? {
          status: 'unverified',
          message: 'Verify the configured HTTPS ingress from a client device.',
        }
      : {
          status: 'failed',
          message:
            'Production needs an HTTPS address: a configured HTTPS ingress URL or the automatic HTTPS address.',
        };
  return {
    status: 'unverified',
    message:
      'Verify access through the configured host ports from a client device.',
  };
}
