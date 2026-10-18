/**
 * Content-Disposition filename for the QA report export (Slice 4). Pure and
 * deterministic given a QaReport, so it is unit-testable without a running
 * app -- see qa-runs.controller.ts for where the header is actually set.
 */

import type { QaReport, QaReportFormat } from './qa-report.contracts';

/**
 * One filename segment: runs outside [A-Za-z0-9._-] become one '-', repeated
 * '-' collapse, leading dots/dashes and trailing dashes go (no hidden or
 * flag-like names), and an empty result reads "unknown". Kept identical to
 * the frontend's sanitizeFilenamePart so a report downloads under the same
 * name from either side.
 */
function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-$/, '');
  return cleaned || 'unknown';
}

function repoNameFrom(repoFullName: string): string {
  return repoFullName.split('/').pop() || repoFullName;
}

/** `QA-Report-<repo>-<branch>-<sha7>.<json|md|xlsx>`, every part sanitised to [A-Za-z0-9._-]. */
export function buildQaReportFilename(
  report: QaReport,
  format: QaReportFormat,
): string {
  const repo = sanitizeFilenamePart(repoNameFrom(report.project.repoFullName));
  const branch = sanitizeFilenamePart(report.run.branch);
  const sha7 = sanitizeFilenamePart(report.run.commitSha.slice(0, 7));
  return `QA-Report-${repo}-${branch}-${sha7}.${format}`;
}
