import {
  clampLogLimit,
  type DeploymentLogLine,
  type DeploymentLogsQuery,
} from '../core/deployment-logs.types';

/**
 * Where a live-tail append tick resumes from. `idsAtTime` holds only the ids
 * seen at exactly `time` — a forward query starting at that same timestamp
 * will re-include any line that lands on the boundary, and this is what lets
 * advanceAppendCursor tell "seen already" apart from "new line, same
 * millisecond" without growing an unbounded id set for a long-lived stream.
 */
export interface AppendCursor {
  time: string;
  idsAtTime: ReadonlySet<string>;
}

/**
 * Folds a page of (oldest -> newest) log lines into the running cursor,
 * returning only the lines not already covered by it. Also used to seed the
 * very first cursor from the initial snapshot, by passing `cursor: null` and
 * discarding `appended` (there is nothing to "append" before the stream has
 * sent anything).
 */
export function advanceAppendCursor(
  cursor: AppendCursor | null,
  logs: readonly DeploymentLogLine[],
): { cursor: AppendCursor | null; appended: DeploymentLogLine[] } {
  const appended: DeploymentLogLine[] = [];
  let time = cursor?.time ?? null;
  let idsAtTime = new Set(cursor?.idsAtTime ?? []);

  for (const line of logs) {
    if (line.timestamp === time) {
      if (idsAtTime.has(line.id)) {
        continue;
      }
      idsAtTime.add(line.id);
    } else {
      time = line.timestamp;
      idsAtTime = new Set([line.id]);
    }
    appended.push(line);
  }

  return {
    cursor: time ? { time, idsAtTime } : cursor,
    appended,
  };
}

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
