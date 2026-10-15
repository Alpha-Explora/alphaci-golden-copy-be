/**
 * The two detailed sections of the CI run report's Markdown: what SonarCloud
 * said (gate, conditions in words, measures, issues) and every browser test
 * (what it checks, how it ended, its steps and its error). Pure.
 */

import type { CiTestCase } from '#kernel/ports/ci-stage-results.port';
import type { StageResults } from './ci-run.types';
import { cell, durationText, EM_DASH, fenced, line } from './markdown-text';

type Sonar = NonNullable<StageResults['sonar']>;

/**
 * SonarCloud's metric keys in words. A key not listed is shown as SonarCloud
 * names it, so a metric added upstream still appears.
 */
const SONAR_METRICS: Record<string, string> = {
  bugs: 'Bugs',
  vulnerabilities: 'Vulnerabilities',
  code_smells: 'Code smells',
  security_hotspots: 'Security hotspots',
  coverage: 'Coverage',
  duplicated_lines_density: 'Duplicated lines',
  new_bugs: 'New bugs',
  new_vulnerabilities: 'New vulnerabilities',
  new_code_smells: 'New code smells',
  new_security_hotspots: 'New security hotspots',
  new_coverage: 'Coverage on new code',
  new_duplicated_lines_density: 'Duplicated lines on new code',
  new_reliability_rating: 'Reliability rating on new code',
  new_security_rating: 'Security rating on new code',
  new_maintainability_rating: 'Maintainability rating on new code',
  new_security_hotspots_reviewed: 'Security hotspots reviewed on new code',
  reliability_rating: 'Reliability rating',
  security_rating: 'Security rating',
  sqale_rating: 'Maintainability rating',
};

/** Metrics SonarCloud reports as a percentage. */
const PERCENT_METRICS = new Set([
  'coverage',
  'duplicated_lines_density',
  'new_coverage',
  'new_duplicated_lines_density',
  'new_security_hotspots_reviewed',
]);

/** SonarCloud reports ratings as 1.0 to 5.0; people read them as A to E. */
const RATING_LETTERS = ['A', 'B', 'C', 'D', 'E'];

export function sonarMetricName(metric: string): string {
  return SONAR_METRICS[metric] ?? metric;
}

export function sonarValueText(metric: string, value: unknown): string {
  const text = line(value);
  if (text === '') {
    return EM_DASH;
  }
  if (metric.endsWith('_rating')) {
    const index = Math.round(Number(text)) - 1;
    return RATING_LETTERS[index] ?? text;
  }
  return PERCENT_METRICS.has(metric) ? `${roundedPercent(text)}%` : text;
}

/**
 * SonarCloud sends some percentages unrounded ("96.27659574468085" for
 * coverage on new code). Show one decimal, as SonarCloud does; a value it
 * already rounded ("96.7", "0.0", "80") is kept exactly.
 */
function roundedPercent(text: string): string {
  const value = Number(text);
  return Number.isFinite(value) && /\.\d{2,}$/.test(text)
    ? value.toFixed(1)
    : text;
}

/** "Coverage on new code 61.2% (needs 80%)". */
export function sonarConditionText(
  condition: NonNullable<Sonar['failedConditions']>[number],
): string {
  const name = sonarMetricName(condition.metric);
  const actual =
    condition.actual !== undefined
      ? ` ${sonarValueText(condition.metric, condition.actual)}`
      : '';
  const needs =
    condition.threshold !== undefined
      ? ` (needs ${sonarValueText(condition.metric, condition.threshold)})`
      : '';
  return `${name}${actual}${needs}`;
}

function measureLines(measures: Sonar['measures']): string[] {
  const entries = Object.entries(measures ?? {});
  if (entries.length === 0) {
    return [];
  }
  return [
    '  - Measures:',
    ...entries.map(
      ([metric, value]) =>
        `    - ${sonarMetricName(metric)}: ${sonarValueText(metric, value)}`,
    ),
  ];
}

function issueLines(issues: Sonar['issues']): string[] {
  const list = issues ?? [];
  if (list.length === 0) {
    return [];
  }
  return [
    `  - Issues on new code (${String(list.length)} listed, most severe first):`,
    ...list.map((issue) => {
      const where =
        issue.file !== undefined
          ? ` — \`${line(issue.file)}${issue.line !== undefined ? `:${String(issue.line)}` : ''}\``
          : '';
      const severity = issue.severity ? `${line(issue.severity)} ` : '';
      return `    - ${severity}${line(issue.message)}${where} (${line(issue.rule)})`;
    }),
  ];
}

/** The SonarCloud block of a stage: gate, failed conditions in words, measures, issues. */
export function sonarDetailLines(sonar: Sonar | undefined): string[] {
  if (!sonar) {
    return [];
  }
  const head = `- **SonarCloud quality gate:** ${sonar.gate ?? EM_DASH}${
    sonar.blockedBy ? ` (blocked by ${line(sonar.blockedBy)})` : ''
  }`;
  const conditions = (sonar.failedConditions ?? []).map(
    (condition) => `  - Failed: ${sonarConditionText(condition)}`,
  );
  return [
    head,
    ...conditions,
    ...measureLines(sonar.measures),
    ...issueLines(sonar.issues),
  ];
}

// ---------------------------------------------------------------------------
// Browser tests
// ---------------------------------------------------------------------------

const CASE_STATUS_WORDS: Record<CiTestCase['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  flaky: 'Passed on retry',
  skipped: 'Skipped',
};

function caseRow(test: CiTestCase): string {
  const what = test.description
    ? `${cell(test.title)}<br>${cell(test.description)}`
    : cell(test.title);
  return `| ${what} | ${CASE_STATUS_WORDS[test.status]} | ${cell(test.project)} | ${durationText(test.durationMs)} |`;
}

function caseDetail(test: CiTestCase): string[] {
  const out = [`##### ${line(test.title)}`, ''];
  if (test.description) {
    out.push(`What it checks: ${line(test.description)}`, '');
  }
  const where = test.file
    ? `\`${line(test.file)}${test.line !== undefined ? `:${String(test.line)}` : ''}\``
    : null;
  const facts = [
    `Result: ${CASE_STATUS_WORDS[test.status]}`,
    where,
    test.project ? `Browser: ${line(test.project)}` : null,
    `Time: ${durationText(test.durationMs)}`,
    test.retries ? `Retries: ${String(test.retries)}` : null,
  ].filter((part): part is string => part !== null);
  out.push(facts.join(' · '), '');
  for (const note of test.notes ?? []) {
    out.push(`- ${line(note.type)}: ${line(note.text)}`);
  }
  if ((test.steps ?? []).length > 0) {
    out.push('', 'Steps:');
    for (const step of test.steps ?? []) {
      out.push(
        `1. ${line(step.title)}${step.failed ? ' — failed' : ''} (${durationText(step.durationMs)})`,
      );
    }
  }
  if (test.error) {
    out.push('', '```', fenced(test.error.message), '```');
    if (test.error.location) {
      out.push(`at \`${line(test.error.location)}\``);
    }
  }
  out.push('');
  return out;
}

/**
 * Every test the browser suite reported: a table of all of them, then the
 * detail of each one that did not simply pass (failed, retried, or with
 * notes such as screenshots waiting for approval).
 */
export function testCaseLines(
  cases: readonly CiTestCase[] | undefined,
  total: number | undefined,
): string[] {
  if (!cases || cases.length === 0) {
    return [];
  }
  const out = [
    `#### Browser tests (${String(cases.length)}${total !== undefined && total > cases.length ? ` of ${String(total)}` : ''})`,
    '',
    '| Test | Result | Browser | Time |',
    '| --- | --- | --- | --- |',
    ...cases.map(caseRow),
    '',
  ];
  const worthReading = cases.filter(
    (test) =>
      test.status !== 'passed' ||
      (test.notes ?? []).length > 0 ||
      (test.steps ?? []).length > 0,
  );
  for (const test of worthReading) {
    out.push(...caseDetail(test));
  }
  return out;
}
