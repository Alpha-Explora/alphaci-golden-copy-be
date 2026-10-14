/**
 * Text helpers for the Markdown reports. Everything here takes `unknown`:
 * stored results are jsonb, so a field typed string may arrive as anything,
 * and one odd value must not fail a whole download.
 */

export const EM_DASH = '—';

/**
 * A timestamp as an ISO string, or null when there is none.
 *
 * The pg driver returns `timestamptz` columns as Date objects and nothing in
 * this app converts them, so a field typed string can be a Date at runtime.
 */
export function isoOf(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Any stored value as text: scalars as written, anything else as nothing. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return value instanceof Date ? (isoOf(value) ?? '') : '';
}

/** A table cell: one line, pipes escaped, EM DASH when empty. */
export function cell(value: unknown): string {
  const escaped = textOf(value)
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
  return escaped.length > 0 ? escaped : EM_DASH;
}

/** A line of prose in a list: newlines folded so it stays one bullet. */
export function line(value: unknown): string {
  return textOf(value)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
}

/**
 * Text for a fenced code block: kept as written, but a run of backticks that
 * would close the fence is broken up, and ANSI colour codes are removed.
 */
export function fenced(value: unknown): string {
  return (
    textOf(value)
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/```/g, '`​``')
      .trimEnd()
  );
}

/** "1.2 s" or "340 ms". */
export function durationText(ms: number | undefined): string {
  if (ms === undefined) {
    return EM_DASH;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(ms)} ms`;
}
