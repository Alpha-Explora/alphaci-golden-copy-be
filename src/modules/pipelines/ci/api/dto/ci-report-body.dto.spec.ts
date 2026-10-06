import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CiReportTestResultsDto } from './ci-report-body.dto';

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
