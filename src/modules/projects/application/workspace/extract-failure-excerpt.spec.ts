import { extractFailureExcerpt } from './extract-failure-excerpt';

/**
 * Shaped from the real log of job 102388067502 on Alphaexplora-Sandbox/
 * testapp1234 — the failing SonarCloud .NET Analysis. The whole point of the
 * rule is that the useful line sits well before the error marker, and the tail
 * is orphan-process cleanup.
 */
const REAL_LOG = [
  '2026-09-09T08:08:50.0000000Z ##[group]Run SonarSource/sonarcloud-github-action',
  '2026-09-09T08:08:51.6378493Z \u001b[36;1m  echo "::error::SonarCloud secrets are not configured."\u001b[0m',
  '2026-09-09T08:08:52.0000000Z ##[endgroup]',
  '2026-09-09T08:09:00.0000000Z Build succeeded.',
  '2026-09-09T08:09:01.0000000Z     4 Warning(s)',
  '2026-09-09T08:09:02.0000000Z     0 Error(s)',
  '2026-09-09T08:09:10.0000000Z SonarScanner for .NET 11.3',
  '2026-09-09T08:09:11.2150000Z 08:09:11.215  Post-processing started.',
  '2026-09-09T08:09:11.3620000Z 08:09:11.362  sonar-project.properties files are not understood by the SonarScanner for .NET. Remove those files from the following folders: /home/runner/work/testapp1234/testapp1234',
  '2026-09-09T08:09:11.3635794Z 08:09:11.363  Post-processing failed. Exit code: 1',
  '2026-09-09T08:09:11.3935124Z ##[error]Process completed with exit code 1.',
  '2026-09-09T08:09:12.0000000Z Post job cleanup.',
  '2026-09-09T08:09:12.1289384Z Terminate orphan process: pid (2971) (dotnet)',
  '2026-09-09T08:09:12.1332120Z Terminate orphan process: pid (3068) (VBCSCompiler)',
].join('\n');

describe('extractFailureExcerpt', () => {
  it('keeps the line that actually explains the failure', () => {
    const excerpt = extractFailureExcerpt(REAL_LOG);
    const text = excerpt.lines.join('\n');

    expect(text).toContain('sonar-project.properties files are not understood');
    expect(excerpt.foundErrorMarker).toBe(true);
  });

  it('drops the cleanup that runs after the failure', () => {
    // The tail of a failed job is orphan-process teardown. Truncating to the
    // tail — the obvious implementation — returns exactly this noise.
    const text = extractFailureExcerpt(REAL_LOG).lines.join('\n');

    expect(text).not.toContain('Terminate orphan process');
    expect(text).not.toContain('Post job cleanup');
  });

  it('strips timestamps, colour codes and fold markers', () => {
    const text = extractFailureExcerpt(REAL_LOG).lines.join('\n');

    expect(text).not.toContain('2026-09-09T08:09:11');
    expect(text).not.toContain('[36;1m');
    expect(text).not.toContain('##[group]');
    expect(text).not.toContain('##[endgroup]');
  });

  it('ends on the error marker', () => {
    const { lines } = extractFailureExcerpt(REAL_LOG);

    expect(lines[lines.length - 1]).toContain(
      'Process completed with exit code 1',
    );
  });

  it('falls back to the last output when nothing marked an error', () => {
    const log = ['first', 'second', 'third'].join('\n');
    const excerpt = extractFailureExcerpt(log, { maxLines: 2 });

    expect(excerpt.foundErrorMarker).toBe(false);
    expect(excerpt.lines).toEqual(['second', 'third']);
    expect(excerpt.truncated).toBe(true);
  });

  it('reports truncation when earlier output was dropped', () => {
    const noise = Array.from({ length: 200 }, (_, i) => `line ${String(i)}`);
    const log = [...noise, '##[error]it broke'].join('\n');

    const excerpt = extractFailureExcerpt(log, { maxLines: 10 });
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.lines.length).toBeLessThanOrEqual(10);
    expect(excerpt.lines[excerpt.lines.length - 1]).toContain('it broke');
  });

  it('does not strand a job that failed during cleanup', () => {
    // Trimming at the cleanup marker must not leave nothing behind.
    const log = ['Post job cleanup.', '##[error]cleanup blew up'].join('\n');

    expect(extractFailureExcerpt(log).lines.join('\n')).toContain(
      'cleanup blew up',
    );
  });

  it('shows the first error of a cascade, not only the last', () => {
    const log = [
      '##[error]first thing broke',
      'more output',
      '##[error]second thing broke',
    ].join('\n');

    const text = extractFailureExcerpt(log).lines.join('\n');
    expect(text).toContain('first thing broke');
    expect(text).toContain('second thing broke');
  });
});
