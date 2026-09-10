/**
 * The part of a job log that says what went wrong.
 *
 * A GitHub Actions log is mostly setup and teardown. Handing the whole thing to
 * a person, or even its tail, does not answer "what failed" — and the tail is
 * actively misleading, because post-job steps run AFTER the failure. The real
 * end of a failed .NET Sonar job looks like this:
 *
 *     Terminate orphan process: pid (2971) (dotnet)
 *
 * while the reason sat 130 lines earlier:
 *
 *     sonar-project.properties files are not understood by the SonarScanner
 *     for .NET. Remove those files from the following folders: ...
 *     Post-processing failed. Exit code: 1
 *     ##[error]Process completed with exit code 1.
 *
 * So the excerpt is anchored on the `##[error]` marker and reaches BACKWARDS,
 * because the explanation always precedes the marker: a tool prints why it is
 * unhappy, then exits non-zero, and the runner records the exit.
 */

/** Timestamps GitHub prefixes to every line: `2026-09-09T08:09:11.9531149Z `. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

/* eslint-disable no-control-regex */
/** Colour codes, which are noise once the log is not going to a terminal. */
const ANSI = /\u001b\[[0-9;]*m|\[\d+(;\d+)*m/g;
/* eslint-enable no-control-regex */

/** Fold markers. The text inside them matters; the markers themselves do not. */
const GROUP_MARKER = /^##\[(group|endgroup)\]/;

/** Where the runner stops running the job and starts tidying up after it. */
const CLEANUP_MARKER = /^(Post job cleanup\.?|Cleaning up orphan processes)/;

export interface FailureExcerpt {
  /** Cleaned log lines, oldest first. */
  lines: string[];
  /** True when earlier output was dropped to fit. */
  truncated: boolean;
  /** True when an explicit error marker anchored the excerpt. */
  foundErrorMarker: boolean;
}

export interface ExcerptOptions {
  /** How far back from the error marker to reach. */
  contextLines?: number;
  /** Hard ceiling on returned lines. */
  maxLines?: number;
}

function clean(line: string): string {
  return line.replace(TIMESTAMP, '').replace(ANSI, '').trimEnd();
}

/**
 * Pull the failing region out of a raw job log.
 *
 * Pure, so the rule is testable against a real captured log rather than only
 * observable by opening the product and hoping.
 */
export function extractFailureExcerpt(
  rawLog: string,
  options: ExcerptOptions = {},
): FailureExcerpt {
  const contextLines = options.contextLines ?? 40;
  const maxLines = options.maxLines ?? 80;

  const cleaned = rawLog
    .split(/\r?\n/)
    .map(clean)
    .filter((line) => !GROUP_MARKER.test(line));

  // Everything after the runner starts tidying up is noise about the failure.
  // Only trimmed when something remains, so a job that failed during cleanup
  // does not end up with an empty excerpt.
  const cleanupAt = cleaned.findIndex((line) => CLEANUP_MARKER.test(line));
  const body = cleanupAt > 0 ? cleaned.slice(0, cleanupAt) : cleaned;

  const errorIndexes = body
    .map((line, index) => (line.includes('##[error]') ? index : -1))
    .filter((index) => index !== -1);

  if (errorIndexes.length === 0) {
    // No marker: the last lines of real output are the best guess available.
    const nonEmpty = trimBlank(body);
    const start = Math.max(0, nonEmpty.length - maxLines);
    return {
      lines: nonEmpty.slice(start),
      truncated: start > 0,
      foundErrorMarker: false,
    };
  }

  const lastError = errorIndexes[errorIndexes.length - 1]!;
  const firstError = errorIndexes[0]!;

  // Prefer showing from the FIRST error, since a cascade explains itself best
  // from the top. Fall back to the last one when the span is too long to fit.
  const preferredStart = Math.max(0, firstError - contextLines);
  const end = Math.min(body.length, lastError + 1);
  const start =
    end - preferredStart <= maxLines
      ? preferredStart
      : Math.max(0, end - maxLines);

  return {
    lines: trimBlank(body.slice(start, end)),
    truncated: start > 0,
    foundErrorMarker: true,
  };
}

function trimBlank(lines: string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first]!.trim() === '') first += 1;
  while (last > first && lines[last - 1]!.trim() === '') last -= 1;
  return lines.slice(first, last);
}
