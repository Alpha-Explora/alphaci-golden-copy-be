import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CiTestCase } from '#kernel/ports/ci-stage-results.port';
import {
  sonarConditionText,
  sonarDetailLines,
  sonarMetricName,
  sonarValueText,
  testCaseLines,
} from './ci-run-report-details';

/** The real per-test records from the logistics2cicd-frontend uat run. */
const REAL_CASES = JSON.parse(
  readFileSync(
    join(__dirname, '__fixtures__/real-playwright-cases.json'),
    'utf8',
  ),
) as CiTestCase[];

describe('SonarCloud in words', () => {
  it('names metrics, and leaves an unknown one as SonarCloud spells it', () => {
    expect(sonarMetricName('new_coverage')).toBe('Coverage on new code');
    expect(sonarMetricName('code_smells')).toBe('Code smells');
    expect(sonarMetricName('cognitive_complexity')).toBe(
      'cognitive_complexity',
    );
  });

  it('adds the unit, and reads ratings as letters', () => {
    expect(sonarValueText('coverage', '74.1')).toBe('74.1%');
    expect(sonarValueText('bugs', '3')).toBe('3');
    expect(sonarValueText('new_security_rating', '1.0')).toBe('A');
    expect(sonarValueText('new_reliability_rating', '3.0')).toBe('C');
    expect(sonarValueText('bugs', undefined)).toBe('—');
  });

  it('says a failed condition as a sentence', () => {
    expect(
      sonarConditionText({
        metric: 'new_coverage',
        actual: '61.2',
        threshold: '80',
      }),
    ).toBe('Coverage on new code 61.2% (needs 80%)');
    expect(sonarConditionText({ metric: 'new_bugs' })).toBe('New bugs');
  });

  it('draws the gate, the conditions, the measures and the issues', () => {
    const lines = sonarDetailLines({
      gate: 'ERROR',
      failedConditions: [
        { metric: 'new_coverage', actual: '61.2', threshold: '80' },
      ],
      measures: { bugs: '0', duplicated_lines_density: '1.4' },
      issues: [
        {
          rule: 'typescript:S1854',
          severity: 'MAJOR',
          message: 'Remove this useless assignment.',
          file: 'src/app.ts',
          line: 12,
        },
      ],
    }).join('\n');

    expect(lines).toContain('- **SonarCloud quality gate:** ERROR');
    expect(lines).toContain(
      '  - Failed: Coverage on new code 61.2% (needs 80%)',
    );
    expect(lines).toContain('    - Bugs: 0');
    expect(lines).toContain('    - Duplicated lines: 1.4%');
    expect(lines).toContain(
      '    - MAJOR Remove this useless assignment. — `src/app.ts:12` (typescript:S1854)',
    );
  });

  it('says the analysis was blocked, and draws nothing without a result', () => {
    expect(
      sonarDetailLines({ blockedBy: 'automatic-analysis' }).join('\n'),
    ).toContain('(blocked by automatic-analysis)');
    expect(sonarDetailLines(undefined)).toEqual([]);
  });
});

describe('browser tests from a real run', () => {
  const markdown = testCaseLines(REAL_CASES, 6).join('\n');

  it('tables every test, with what it checks under its name', () => {
    expect(markdown).toContain('#### Browser tests (6)');
    expect(markdown).toContain(
      '| a11y.e2e-spec.ts > no critical or serious accessibility violations on /<br>Runs the axe accessibility checker on /',
    );
    expect(markdown).toContain('| Failed | chromium |');
  });

  it('details the failure: what it checks, where, its steps and its full error', () => {
    expect(markdown).toContain(
      'What it checks: Runs the axe accessibility checker on / and fails on any critical or serious violation',
    );
    expect(markdown).toContain('`tests/e2e/a11y.e2e-spec.ts:11`');
    expect(markdown).toContain('Retries: 1');
    expect(markdown).toContain(
      '- result: 3 critical or serious and 2 minor or moderate violations; 23 accessibility rules passed',
    );
    expect(markdown).toContain(
      '1. Check for critical or serious violations — failed',
    );
    expect(markdown).toContain(
      'label (critical): Form elements must have labels',
    );
    expect(markdown).toContain('at `tests/e2e/a11y.e2e-spec.ts:51`');
  });

  it('details a passing test only when it has something to say', () => {
    expect(markdown).toContain(
      '- visual: home-desktop.png: new screenshot, waiting for approval in ALPHACI',
    );
    expect(markdown).toContain(
      '- result: 0 same-site links found, 0 checked, 0 broken',
    );
    // The repository's own test declares no description, steps or notes.
    expect(markdown).not.toContain('##### home.e2e-spec.ts');
  });

  it('never leaks the runner path', () => {
    expect(markdown).not.toMatch(/[A-Z]:\\Users|\/home\/runner/);
  });

  it('says how many there were when the list is a prefix, and nothing when empty', () => {
    expect(testCaseLines(REAL_CASES.slice(0, 2), 40).join('\n')).toContain(
      '#### Browser tests (2 of 40)',
    );
    expect(testCaseLines([], 0)).toEqual([]);
    expect(testCaseLines(undefined, undefined)).toEqual([]);
  });
});
