import { translateResults } from './translate-results';
import type { CiResults } from './translate-results';

describe('translateResults', () => {
  describe('conclusion = cancelled', () => {
    it('returns a single info message regardless of stage or results', () => {
      const msgs = translateResults('quality', 'cancelled', {});
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.severity).toBe('info');
      expect(msgs[0]?.title).toBe('Stage was cancelled');
    });

    it('does not fire other checks when cancelled', () => {
      const msgs = translateResults('quality', 'cancelled', {
        tests: { passed: 0, failed: 5, total: 5 },
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.severity).toBe('info');
    });
  });

  describe('conclusion = failure with empty results', () => {
    it('explains when quality diagnostics were not reported', () => {
      const msgs = translateResults('quality', 'failure', {});
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.severity).toBe('error');
      expect(msgs[0]?.title).toBe(
        'Quality check failed before diagnostics were reported',
      );
      expect(msgs[0]?.hint).toContain('first failed quality step');
    });

    it('explains when access diagnostics were not reported', () => {
      const msgs = translateResults('access', 'failure', {});
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.severity).toBe('error');
      expect(msgs[0]?.title).toBe(
        'Access check failed before diagnostics were reported',
      );
      expect(msgs[0]?.hint).toContain('ALPHACI_TOKEN');
    });

    it('explains when package diagnostics were not reported', () => {
      const msgs = translateResults('package', 'failure', {});
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.title).toBe(
        'Build or package check failed before diagnostics were reported',
      );
    });

    it('turns a reported failed job into a concrete fix', () => {
      const msgs = translateResults(
        'quality',
        'failure',
        {},
        'Failed GitHub Actions job: typecheck',
      );
      expect(msgs[0]?.title).toBe('Type check failed');
      expect(msgs[0]?.hint).toContain('npm run typecheck');
      expect(msgs[0]?.items).toEqual([{ label: 'typecheck' }]);
    });
  });

  describe('tests', () => {
    it('returns success message when all tests pass on success conclusion', () => {
      const msgs = translateResults('quality', 'success', {
        tests: { passed: 10, failed: 0, total: 10 },
      });
      const success = msgs.find((m) => m.severity === 'success');
      expect(success).toBeDefined();
      expect(success?.title).toBe('All tests passed');
    });

    it('returns error when tests.failed > 0', () => {
      const msgs = translateResults('quality', 'failure', {
        tests: { passed: 7, failed: 3, total: 10 },
      });
      const err = msgs.find(
        (m) => m.severity === 'error' && m.title.includes('test'),
      );
      expect(err).toBeDefined();
      expect(err?.title).toBe('3 test(s) failed');
      expect(err?.detail).toContain('3 of 10');
      expect(err?.hint).toContain('GitHub Actions');
    });

    it('does not return success message when tests.failed > 0 even if conclusion is success', () => {
      const msgs = translateResults('quality', 'success', {
        tests: { passed: 0, failed: 1, total: 1 },
      });
      const success = msgs.find((m) => m.severity === 'success');
      expect(success).toBeUndefined();
    });
  });

  describe('coverage', () => {
    it('returns warning when coverage.pct < coverage.threshold', () => {
      const msgs = translateResults('quality', 'failure', {
        coverage: { pct: 60, threshold: 80 },
      });
      const warn = msgs.find(
        (m) => m.severity === 'warning' && m.title.includes('Coverage'),
      );
      expect(warn).toBeDefined();
      expect(warn?.detail).toContain('60%');
      expect(warn?.detail).toContain('80%');
      expect(warn?.hint).toContain('tests');
    });

    it('does not fire when coverage.pct >= coverage.threshold', () => {
      const msgs = translateResults('quality', 'success', {
        coverage: { pct: 80, threshold: 80 },
      });
      const warn = msgs.find((m) => m.title.includes('Coverage'));
      expect(warn).toBeUndefined();
    });
  });

  describe('lint', () => {
    it('returns error when lint.errors > 0', () => {
      const msgs = translateResults('quality', 'failure', {
        lint: { errors: 5, warnings: 2 },
      });
      const err = msgs.find(
        (m) => m.severity === 'error' && m.title.includes('lint'),
      );
      expect(err).toBeDefined();
      expect(err?.title).toBe('5 lint error(s)');
      expect(err?.hint).toContain('npm run lint');
    });

    it('returns warning when lint.warnings > 0 and no errors', () => {
      const msgs = translateResults('quality', 'success', {
        lint: { errors: 0, warnings: 3 },
      });
      const warn = msgs.find(
        (m) => m.severity === 'warning' && m.title.includes('lint'),
      );
      expect(warn).toBeDefined();
      expect(warn?.title).toBe('3 lint warning(s)');
    });

    it('does not return warning for lint when errors > 0 (error takes priority)', () => {
      const msgs = translateResults('quality', 'failure', {
        lint: { errors: 2, warnings: 5 },
      });
      const warnLint = msgs.find(
        (m) => m.severity === 'warning' && m.title.includes('lint'),
      );
      expect(warnLint).toBeUndefined();
    });
  });

  describe('security', () => {
    it('returns error when security.critical > 0', () => {
      const msgs = translateResults('quality', 'failure', {
        security: { high: 1, critical: 2 },
      });
      const err = msgs.find(
        (m) => m.severity === 'error' && m.title.includes('critical'),
      );
      expect(err).toBeDefined();
      expect(err?.title).toBe('2 critical vulnerability(s)');
      expect(err?.hint).toContain('npm audit');
    });

    it('returns warning when security.high > 0 and no critical', () => {
      const msgs = translateResults('quality', 'failure', {
        security: { high: 3, critical: 0 },
      });
      const warn = msgs.find(
        (m) => m.severity === 'warning' && m.title.includes('high'),
      );
      expect(warn).toBeDefined();
      expect(warn?.title).toBe('3 high-severity vulnerability(s)');
      expect(warn?.hint).toContain('npm audit');
    });

    it('does not return high warning when critical > 0', () => {
      const msgs = translateResults('quality', 'failure', {
        security: { high: 3, critical: 1 },
      });
      const warnHigh = msgs.find(
        (m) => m.severity === 'warning' && m.title.includes('high'),
      );
      expect(warnHigh).toBeUndefined();
    });
  });

  describe('multiple messages fire simultaneously', () => {
    it('returns both test error and coverage warning at the same time', () => {
      const results: CiResults = {
        tests: { passed: 0, failed: 2, total: 10 },
        coverage: { pct: 40, threshold: 80 },
      };
      const msgs = translateResults('quality', 'failure', results);
      const testErr = msgs.find((m) => m.title.includes('test'));
      const covWarn = msgs.find((m) => m.title.includes('Coverage'));
      expect(testErr).toBeDefined();
      expect(covWarn).toBeDefined();
    });

    it('returns lint error and security error simultaneously', () => {
      const results: CiResults = {
        lint: { errors: 1, warnings: 0 },
        security: { high: 0, critical: 1 },
      };
      const msgs = translateResults('quality', 'failure', results);
      expect(msgs.filter((m) => m.severity === 'error')).toHaveLength(2);
    });
  });
});
