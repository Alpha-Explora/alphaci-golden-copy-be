/**
 * Deployment log DTOs shared by the application service, every provider
 * adapter, and the API layer. Living in core/ (rather than application/ or
 * infrastructure/) is deliberate: application must not import infrastructure
 * (check:application-boundaries enforces this), so the level-normalisation
 * and limit-clamping helpers below - needed by both the Render/Vercel
 * mappers AND the mock-log fallback in the application service - have to sit
 * somewhere both sides may import.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogDirection = 'backward' | 'forward';
export type LogFilterKey = 'level' | 'type' | 'text' | 'instance';
export type LogLineType = 'app' | 'build' | 'request';

export interface DeploymentLogLine {
  /** Provider line id; dedupe key. */
  id: string;
  timestamp: string;
  message: string;
  level: LogLevel;
  type: LogLineType | null;
  instance: string | null;
  /** Every raw label the provider attached, for parity/debug. */
  labels: Record<string, string>;
}

export interface DeploymentLogsWindow {
  startTime: string;
  endTime: string;
}

/**
 * 'simulated' is reserved for local-mock mode (live providers disabled
 * platform-wide). A live provider call that fails reports 'unavailable' with
 * a reason and no lines - it must never silently fall back to sample data,
 * which is what the old behaviour did and this contract replaces.
 */
export type DeploymentLogsSource = 'live' | 'unavailable' | 'simulated';

export interface DeploymentLogsResponse {
  source: DeploymentLogsSource;
  reason?: string;
  /** Always oldest -> newest, whatever direction was queried. */
  logs: DeploymentLogLine[];
  hasMore: boolean;
  /** Pass back as startTime/endTime with the SAME direction for the next page. */
  next: DeploymentLogsWindow | null;
  /** Filters this provider supports; callers should only render these. */
  filters: LogFilterKey[];
}

/** Query knobs accepted by the deployment logs endpoint and its SSE stream. */
export interface DeploymentLogsQuery {
  startTime?: string;
  endTime?: string;
  direction?: LogDirection;
  limit?: number;
  type?: string[];
  level?: string[];
  text?: string;
  instance?: string[];
}

/**
 * Normalises a provider's free-text level label into the fixed vocabulary
 * the API promises: error|fatal|critical -> error, warn|warning -> warn,
 * debug|trace -> debug, anything else (including missing) -> info. Shared by
 * every provider mapping and by the mock-log fallback, so a provider's
 * vocabulary only has to be taught to this one function.
 */
export function normalizeLogLevel(
  rawLevel: string | null | undefined,
): LogLevel {
  const level = rawLevel?.trim().toLowerCase();
  if (level === 'error' || level === 'fatal' || level === 'critical') {
    return 'error';
  }
  if (level === 'warn' || level === 'warning') {
    return 'warn';
  }
  if (level === 'debug' || level === 'trace') {
    return 'debug';
  }

  return 'info';
}

/** Clamps a caller-supplied page size to the 1..100 contract every provider shares. */
export function clampLogLimit(
  limit: number | undefined,
  fallback = 100,
): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return fallback;
  }

  return Math.min(100, Math.max(1, Math.trunc(limit)));
}
