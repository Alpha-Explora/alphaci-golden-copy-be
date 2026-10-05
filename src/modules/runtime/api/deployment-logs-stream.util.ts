import {
  clampLogLimit,
  type DeploymentLogsQuery,
} from '../core/deployment-logs.types';

// The append cursor moved to the application layer with the shared log poller
// (it is tail-dedupe logic, not request parsing); re-exported so existing
// callers and specs keep their import path.
export {
  advanceAppendCursor,
  type AppendCursor,
} from '../application/deployment-logs-append-cursor';

/**
 * Mirrors how NestJS calls a controller method: every `@Query(...)` param is
 * always passed positionally, so each key here is always present but its
 * value may be undefined (an absent query string param) rather than the key
 * itself being optional.
 */
export interface RawDeploymentLogsQuery {
  startTime: string | undefined;
  endTime: string | undefined;
  direction: string | undefined;
  limit: string | undefined;
  type: string | undefined;
  level: string | undefined;
  text: string | undefined;
  instance: string | undefined;
}

/** Parses `?mode=append`, `?type=build,app`, etc. from raw query strings into DeploymentLogsQuery. */
export function parseDeploymentLogsQuery(
  raw: RawDeploymentLogsQuery,
): DeploymentLogsQuery {
  const type = parseCommaList(raw.type);
  const level = parseCommaList(raw.level);
  const instance = parseCommaList(raw.instance);
  const rawLimit = raw.limit ? Number(raw.limit) : undefined;

  return {
    ...(raw.startTime ? { startTime: raw.startTime } : {}),
    ...(raw.endTime ? { endTime: raw.endTime } : {}),
    ...(raw.direction === 'forward' ? { direction: 'forward' as const } : {}),
    // Clamped here (not just deep in the Render client) so the 1..100
    // contract holds for every provider, including Vercel's client-side path.
    ...(rawLimit !== undefined && Number.isFinite(rawLimit)
      ? { limit: clampLogLimit(rawLimit) }
      : {}),
    ...(type ? { type } : {}),
    ...(level ? { level } : {}),
    ...(raw.text ? { text: raw.text } : {}),
    ...(instance ? { instance } : {}),
  };
}

function parseCommaList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length ? items : undefined;
}
