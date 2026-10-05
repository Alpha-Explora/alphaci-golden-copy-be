import type { DeploymentLogLine } from '../core/deployment-logs.types';

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
