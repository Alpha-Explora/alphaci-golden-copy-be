import { buildQaReportFilename } from './qa-report.filename';
import type { QaReport } from './qa-report.contracts';

/*
 * The frontend names its JSON download with the same rule
 * (features/checklists/model/qa-report-rules.ts reportFilename), so a report
 * has one name whichever side produced it. These cases mirror its tests.
 */
const reportWith = (repoFullName: string, branch: string, commitSha: string) =>
  ({
    project: { id: 'p1', repoFullName, name: 'fallback' },
    run: { branch, commitSha },
  }) as unknown as QaReport;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('buildQaReportFilename', () => {
  it('uses the repository name, not owner/repo', () => {
    expect(
      buildQaReportFilename(reportWith('tone/orders-api', 'main', SHA), 'json'),
    ).toBe('QA-Report-orders-api-main-a1b2c3d.json');
  });

  it('collapses disallowed runs and trims trailing dashes', () => {
    expect(
      buildQaReportFilename(
        reportWith('tone/orders-api', 'feat/checkout v2 ✓', SHA),
        'md',
      ),
    ).toBe('QA-Report-orders-api-feat-checkout-v2-a1b2c3d.md');
  });

  it('never produces hidden or flag-like segments', () => {
    expect(
      buildQaReportFilename(
        reportWith('tone/..hidden', '--rm -rf', SHA),
        'json',
      ),
    ).toBe('QA-Report-hidden-rm-rf-a1b2c3d.json');
  });

  it('falls back to "unknown" for a segment with nothing allowed in it', () => {
    expect(
      buildQaReportFilename(reportWith('tone/orders-api', '///', SHA), 'json'),
    ).toBe('QA-Report-orders-api-unknown-a1b2c3d.json');
  });
});
