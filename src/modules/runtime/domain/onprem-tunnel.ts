import type {
  AssignmentIngress,
  TunnelReport,
  TunnelStatus,
} from '#kernel/ports/onprem-assignment.port';

/** A machine reports every 30 seconds; a report older than this is stale. */
export const TUNNEL_REPORT_WINDOW = `90 seconds`;

/** The part of a binding's tunnel columns that the API presents. */
export interface TunnelReportRow {
  status: TunnelStatus | null;
  url: string | null;
  message: string | null;
  reportedAt: Date | null;
  fresh: boolean;
}

export const WAITING_FOR_TUNNEL =
  'Waiting for the machine to report its address.';

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
    message: row.message ?? WAITING_FOR_TUNNEL,
    reportedAt,
  };
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

/** The host port the tunnel serves: the frontend when there is one. */
export function tunnelPort(
  ports: ReadonlyArray<{ slot: string; hostPort: number }>,
): number | null {
  const port = ports.find((item) => item.slot === 'frontend') ?? ports[0];
  return port?.hostPort ?? null;
}

/**
 * Readiness of the ingress for an assignment. Production needs an HTTPS
 * address: a configured one, or the tunnel's once the machine reports it.
 */
export function ingressReadiness(
  ingress: AssignmentIngress,
  tunnel: TunnelReport | null,
  production: boolean,
): { status: 'passed' | 'failed' | 'unverified'; message: string } {
  if (ingress.mode === 'tunnel') {
    return tunnel?.publicUrl
      ? {
          status: 'unverified',
          message: `Automatic HTTPS address reported by the machine: ${tunnel.publicUrl}. Open it from a client device to confirm it reaches the application.`,
        }
      : {
          status: 'failed',
          message: tunnel?.message ?? WAITING_FOR_TUNNEL,
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
