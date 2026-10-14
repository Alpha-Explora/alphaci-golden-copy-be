import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CiReportSonarDto, CiReportTestResultsDto } from './ci-report-body.dto';

/**
 * Real per-test records: the Playwright starter pack run against the
 * logistics2cicd-frontend uat site on 2026-10-09, summarised by the central
 * workflow's own script. One accessibility failure with its full error.
 */
const REAL_CASES = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../application/__fixtures__/real-playwright-cases.json',
    ),
    'utf8',
  ),
) as Array<Record<string, unknown>>;

const check = (passes: unknown) =>
  validate(
    plainToInstance(CiReportTestResultsDto, {
      total: 2,
      passed: 1,
      failed: 1,
      passes,
    }),
    { whitelist: true, forbidNonWhitelisted: true },
  );

describe('CiReportTestResultsDto.passes', () => {
  it('is optional (older pipelines)', async () => {
    expect(await check(undefined)).toHaveLength(0);
  });

  it('accepts names and an empty array', async () => {
    expect(await check(['a.spec.ts > t'])).toHaveLength(0);
    expect(await check([])).toHaveLength(0);
  });

  it('rejects more than 500 entries', async () => {
    expect(
      await check(Array.from({ length: 501 }, () => 'n')),
    ).not.toHaveLength(0);
    expect(await check(Array.from({ length: 500 }, () => 'n'))).toHaveLength(0);
  });

  it('rejects a name over 500 characters and non-strings', async () => {
    expect(await check(['x'.repeat(501)])).not.toHaveLength(0);
    expect(await check(['x'.repeat(500)])).toHaveLength(0);
    expect(await check([1])).not.toHaveLength(0);
    expect(await check('a')).not.toHaveLength(0);
  });
});

const checkCases = (cases: unknown) =>
  validate(
    plainToInstance(CiReportTestResultsDto, {
      total: 6,
      passed: 5,
      failed: 1,
      cases,
    }),
    { whitelist: true, forbidNonWhitelisted: true },
  );

describe('CiReportTestResultsDto.cases', () => {
  it('accepts the real records a Playwright run produced', async () => {
    expect(REAL_CASES).toHaveLength(6);
    expect(await checkCases(REAL_CASES)).toHaveLength(0);
  });

  it('is optional, so a pipeline that does not send it still reports', async () => {
    expect(await checkCases(undefined)).toHaveLength(0);
  });

  it('needs a title and a known status on each test', async () => {
    expect(await checkCases([{ status: 'passed' }])).not.toHaveLength(0);
    expect(
      await checkCases([{ title: 't', status: 'exploded' }]),
    ).not.toHaveLength(0);
    expect(await checkCases([{ title: 't', status: 'flaky' }])).toHaveLength(0);
  });

  it('rejects a field it does not know, as the rest of the report does', async () => {
    expect(
      await checkCases([{ title: 't', status: 'passed', screenshot: 'x' }]),
    ).not.toHaveLength(0);
  });

  it('keeps the limits the workflow trims to', async () => {
    const one = { title: 't', status: 'failed' };
    expect(
      await checkCases(Array.from({ length: 51 }, () => one)),
    ).not.toHaveLength(0);
    expect(
      await checkCases([{ ...one, error: { message: 'x'.repeat(4001) } }]),
    ).not.toHaveLength(0);
    expect(
      await checkCases([
        { ...one, steps: Array.from({ length: 21 }, () => ({ title: 's' })) },
      ]),
    ).not.toHaveLength(0);
  });
});

const checkSonar = (sonar: unknown) =>
  validate(plainToInstance(CiReportSonarDto, sonar), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('CiReportSonarDto.issues', () => {
  const issue = {
    rule: 'typescript:S1854',
    severity: 'MAJOR',
    type: 'CODE_SMELL',
    message: 'Remove this useless assignment to variable "x".',
    file: 'src/app.ts',
    line: 12,
  };

  it('accepts issues beside the gate, conditions and measures', async () => {
    expect(
      await checkSonar({
        gate: 'ERROR',
        failedConditions: [
          { metric: 'new_coverage', actual: '61.2', threshold: '80' },
        ],
        measures: { bugs: '0', coverage: '74.1' },
        issues: [issue],
      }),
    ).toHaveLength(0);
  });

  it('is optional', async () => {
    expect(await checkSonar({ gate: 'OK' })).toHaveLength(0);
  });

  it('caps the list at 20 and needs a rule and a message', async () => {
    expect(
      await checkSonar({ issues: Array.from({ length: 21 }, () => issue) }),
    ).not.toHaveLength(0);
    expect(await checkSonar({ issues: [{ rule: 'r' }] })).not.toHaveLength(0);
  });
});
