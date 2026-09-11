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
      // Tool-neutral: this path serves .NET too, where the command is
      // `dotnet list package --vulnerable`, and naming the wrong one is worse
      // than naming none.
      expect(err?.hint).toContain('Upgrade the packages listed below');
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
      expect(warn?.hint).toContain('Upgrade the packages listed below');
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

describe('translateResults — a failure is always explained', () => {
  /*
   * Regression: the exact row behind the empty QUALITY failure in the product.
   * Coverage was reported and PASSED (100 >= 90), which satisfied the old
   * `!hasResults` guard, so the failure path was skipped and nothing else
   * matched. The stage rendered as failed with no explanation at all.
   */
  it('explains a failure whose results passed and say nothing about it', () => {
    const messages = translateResults(
      'quality',
      'failure',
      { coverage: { pct: 100, threshold: 90 } },
      'Failed GitHub Actions job: sonar / SonarCloud Analysis',
    );

    const error = messages.find((message) => message.severity === 'error');
    expect(error).toBeDefined();
    expect(error?.items?.[0]?.label).toContain('SonarCloud Analysis');
  });

  it('leads with the failure, not the coverage warning', () => {
    const messages = translateResults(
      'quality',
      'failure',
      { coverage: { pct: 50, threshold: 90 } },
      'Failed GitHub Actions job: build',
    );

    expect(messages[0]?.severity).toBe('error');
    expect(messages.some((m) => m.title === 'Coverage below threshold')).toBe(
      true,
    );
  });

  it('does not add a vaguer duplicate when the results already explain it', () => {
    const messages = translateResults(
      'quality',
      'failure',
      { tests: { total: 10, passed: 8, failed: 2 } },
      'Failed GitHub Actions job: test',
    );

    const errors = messages.filter((message) => message.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.title).toBe('2 test(s) failed');
  });

  it('still explains a failure that reported nothing at all', () => {
    const messages = translateResults('quality', 'failure', {});

    expect(messages).toHaveLength(1);
    expect(messages[0]?.severity).toBe('error');
  });

  it('stays quiet on success', () => {
    const messages = translateResults('quality', 'success', {
      coverage: { pct: 100, threshold: 90 },
    });

    expect(messages.some((message) => message.severity === 'error')).toBe(
      false,
    );
  });
});

describe('translateResults — annotations name the actual errors', () => {
  it('reports the file and line of each error, not just the job', () => {
    const messages = translateResults(
      'quality',
      'failure',
      {},
      'Failed GitHub Actions job: lint',
      [
        { path: 'src/app.ts', line: 42, message: "'x' is never used" },
        { path: 'src/main.ts', line: 7, message: 'Missing return type' },
      ],
    );

    const error = messages.find((message) => message.severity === 'error');
    expect(error?.items?.[0]).toEqual({
      label: 'src/app.ts:42',
      sub: "'x' is never used",
    });
    expect(error?.detail).toContain('2 errors');
  });

  it('prefers annotations over the job name, since they say what is wrong', () => {
    const messages = translateResults(
      'quality',
      'failure',
      { coverage: { pct: 100, threshold: 90 } },
      'Failed GitHub Actions job: sonar / SonarCloud Analysis',
      [{ path: 'src/a.ts', line: 1, message: 'Cognitive complexity too high' }],
    );

    const error = messages.find((message) => message.severity === 'error');
    expect(error?.items?.[0]?.label).toBe('src/a.ts:1');
  });

  it('still works for a pipeline too old to send annotations', () => {
    const messages = translateResults(
      'quality',
      'failure',
      {},
      'Failed GitHub Actions job: lint',
    );

    const error = messages.find((message) => message.severity === 'error');
    expect(error?.items?.[0]?.label).toContain('lint');
  });

  it('falls back to the message when an annotation has no file', () => {
    const messages = translateResults('quality', 'failure', {}, undefined, [
      { message: 'Process completed with exit code 1' },
    ]);

    const error = messages.find((message) => message.severity === 'error');
    expect(error?.items?.[0]?.label).toBe('Process completed with exit code 1');
  });
});

/*
 * SonarCloud's verdict, said in the product.
 *
 * "Quality gate failed" is the same non-answer as "the quality stage failed"
 * one level down — it tells a reader something is wrong and nothing about
 * what, and the only way on was to open SonarCloud, which is what this is
 * meant to remove.
 */
describe('translateResults — SonarCloud findings', () => {
  const sonarOf = (sonar: NonNullable<CiResults['sonar']>) =>
    translateResults('quality', 'failure', { sonar });

  it('names the failed condition, its value and the value required', () => {
    const messages = sonarOf({
      gate: 'ERROR',
      failedConditions: [
        {
          metric: 'new_coverage',
          status: 'ERROR',
          actual: '61.2',
          threshold: '80',
        },
      ],
    });

    const gate = messages.find((message) =>
      message.title.includes('quality gate failed'),
    );

    expect(gate).toBeDefined();
    expect(gate!.severity).toBe('error');
    expect(gate!.items).toEqual([
      { label: 'new_coverage: 61.2', sub: 'required 80' },
    ]);
  });

  it('omits the threshold rather than sending it as null', () => {
    const messages = sonarOf({
      gate: 'ERROR',
      failedConditions: [{ metric: 'new_bugs', actual: '3' }],
    });

    const gate = messages.find((message) =>
      message.title.includes('quality gate failed'),
    );

    expect(gate!.items).toEqual([{ label: 'new_bugs: 3' }]);
    expect(gate!.items![0]).not.toHaveProperty('sub');
  });

  /*
   * The case this exists to prevent: the analysis ran, the verdict never came
   * back, and the stage looks clean on the strength of a check nobody heard
   * the result of. It is the same shape as a stage of skipped jobs reporting
   * success — an unchecked state defaulting to the most optimistic answer.
   */
  it('reports a gate it could not read instead of passing over it', () => {
    const messages = sonarOf({ gate: 'UNKNOWN' });

    const unread = messages.find((message) =>
      message.title.includes('could not be read'),
    );

    expect(unread).toBeDefined();
    expect(unread!.severity).toBe('warning');
    expect(unread!.hint).toContain('unverified');
  });

  it('says nothing about the gate when it passed', () => {
    const messages = sonarOf({ gate: 'OK' });

    expect(
      messages.filter((message) => message.title.includes('quality gate')),
    ).toHaveLength(0);
  });

  it('reports the totals even when the gate passed', () => {
    // A gate decides on NEW code, so a project can clear it while still
    // carrying bugs. A reader after that number should not have to fail the
    // build to be shown it.
    const messages = translateResults('quality', 'success', {
      sonar: {
        gate: 'OK',
        measures: { bugs: '2', code_smells: '17', vulnerabilities: '0' },
      },
    });

    const findings = messages.find(
      (message) => message.title === 'SonarCloud findings',
    );

    expect(findings).toBeDefined();
    expect(findings!.severity).toBe('info');
    expect(findings!.detail).toBe('2 bug(s), 17 code smell(s)');
    // Zero is not a finding.
    expect(findings!.detail).not.toContain('vulnerability');
  });

  it('stays quiet when every measure is zero', () => {
    const messages = translateResults('quality', 'success', {
      sonar: { gate: 'OK', measures: { bugs: '0', code_smells: '0' } },
    });

    expect(
      messages.filter((message) => message.title === 'SonarCloud findings'),
    ).toHaveLength(0);
  });
});

/*
 * Diagnostics have to reach the reader on the branch that can still act on them.
 *
 * The annotation message only ever ran when a failure had nothing else to
 * explain it. On dev the gates are advisory, so the stage concludes SUCCESS,
 * and the annotations were fetched, sent, stored and never shown — on the one
 * branch where there was still time to fix them.
 */
describe('translateResults — diagnostics on a stage that passed', () => {
  const annotations = [
    {
      path: 'src/Program.cs',
      line: 11,
      message: 'Await RunAsync instead of blocking.',
      level: 'warning',
    },
    {
      path: 'src/Domain/ServiceStatus.cs',
      line: 4,
      message: 'Remove this unused using.',
      level: 'warning',
    },
  ];

  it('shows diagnostics from a stage that succeeded', () => {
    const messages = translateResults(
      'quality',
      'success',
      {},
      undefined,
      annotations,
    );

    const advisory = messages.find((message) =>
      message.title.includes('without failing this stage'),
    );

    expect(advisory).toBeDefined();
    expect(advisory!.items).toHaveLength(2);
    expect(advisory!.items![0]!.label).toBe('src/Program.cs:11');
    expect(advisory!.items![0]!.sub).toBe(
      'Await RunAsync instead of blocking.',
    );
  });

  /*
   * A passing stage must not be coloured as an error. The point is that these
   * did not block here — overstating them is its own lie, in the opposite
   * direction from hiding them.
   */
  it('marks them advisory, not as errors, when the stage passed', () => {
    const messages = translateResults(
      'quality',
      'success',
      {},
      undefined,
      annotations,
    );

    const advisory = messages.find((message) =>
      message.title.includes('without failing this stage'),
    );

    expect(advisory!.severity).toBe('warning');
    expect(messages.some((message) => message.severity === 'error')).toBe(
      false,
    );
  });

  it('says the promotion is what they will block', () => {
    const messages = translateResults(
      'quality',
      'success',
      {},
      undefined,
      annotations,
    );

    const advisory = messages.find((message) =>
      message.title.includes('without failing this stage'),
    );

    // The whole reason to show an advisory warning is that it stops being
    // advisory one branch later.
    expect(advisory!.hint).toContain('uat');
  });

  /*
   * A failure that already explains itself still had its annotations thrown
   * away: tests failing does not make twelve formatter diagnostics
   * uninteresting.
   */
  it('keeps diagnostics alongside a failure that already has a reason', () => {
    const messages = translateResults(
      'quality',
      'failure',
      { tests: { passed: 3, failed: 1, total: 4 } },
      undefined,
      annotations,
    );

    expect(messages.some((message) => message.severity === 'error')).toBe(true);
    const extra = messages.find((message) =>
      message.title.includes('more diagnostic'),
    );
    expect(extra).toBeDefined();
    expect(extra!.items).toHaveLength(2);
  });

  it('still explains a bare failure with the annotations themselves', () => {
    const messages = translateResults(
      'quality',
      'failure',
      {},
      undefined,
      annotations,
    );

    // Unchanged behaviour: with nothing else to go on, the annotations ARE the
    // explanation and lead the list rather than trailing it.
    expect(messages[0]!.severity).toBe('error');
    expect(messages[0]!.items).toHaveLength(2);
  });

  it('says nothing when there are no diagnostics', () => {
    const messages = translateResults('quality', 'success', {}, undefined, []);

    expect(
      messages.filter((message) => message.title.includes('diagnostic')),
    ).toHaveLength(0);
  });
});

/*
 * Which secret, which licence — not how many.
 *
 * Both gates reported a count, and the count was stored and never shown. Even
 * shown, "3 findings" is barely better than a red tick: it says a problem
 * exists and leaves locating it as homework, which is the trip to GitHub this
 * is meant to replace.
 */
describe('translateResults — secret and licence findings', () => {
  it('names the file and line of each secret', () => {
    const messages = translateResults('quality', 'failure', {
      findings: {
        secrets: 2,
        secretItems: [
          { rule: 'generic-api-key', file: 'src/appsettings.json', line: 12 },
          { rule: 'aws-access-key', file: 'deploy/env.sh', line: 3 },
        ],
      },
    });

    const secrets = messages.find((message) =>
      message.title.includes('committed secret'),
    );

    expect(secrets).toBeDefined();
    expect(secrets!.items).toEqual([
      { label: 'src/appsettings.json:12', sub: 'generic-api-key' },
      { label: 'deploy/env.sh:3', sub: 'aws-access-key' },
    ]);
  });

  /*
   * The report must never carry the secret itself. It is redacted upstream by
   * construction, and this asserts nothing downstream reintroduces it.
   */
  it('carries no secret value anywhere in the message', () => {
    const messages = translateResults('quality', 'failure', {
      findings: {
        secrets: 1,
        secretItems: [
          { rule: 'generic-api-key', file: 'src/appsettings.json', line: 12 },
        ],
      },
    });

    expect(JSON.stringify(messages)).not.toMatch(
      /secretvalue|password|token=/i,
    );
  });

  it('tells the reader to rotate before deleting', () => {
    const messages = translateResults('quality', 'failure', {
      findings: { secrets: 1 },
    });

    // Removing the line does not revoke a credential that has already been
    // pushed, and a secret treated as fixed because it is gone from HEAD is
    // still live wherever it was published.
    const secrets = messages.find((message) =>
      message.title.includes('committed secret'),
    );
    expect(secrets!.hint).toMatch(/rotate/i);
  });

  it('names the package and licence, not just a number', () => {
    const messages = translateResults('quality', 'failure', {
      findings: {
        forbiddenLicenses: 1,
        licenseItems: [
          {
            package: 'Some.Copyleft.Lib',
            version: '1.0.0',
            license: 'GPL-3.0',
          },
        ],
      },
    });

    const licences = messages.find((message) =>
      message.title.includes('forbidden licence'),
    );

    expect(licences!.items).toEqual([
      { label: 'Some.Copyleft.Lib@1.0.0', sub: 'GPL-3.0' },
    ]);
  });

  /*
   * Severity follows the branch, not the finding. On dev these gates are
   * advisory and the job passes, so an error would contradict a stage the
   * product just called green.
   */
  it('reports advisory findings as warnings on a stage that passed', () => {
    const messages = translateResults('quality', 'success', {
      findings: { secrets: 3, forbiddenLicenses: 1 },
    });

    for (const message of messages) {
      expect(message.severity).not.toBe('error');
    }
    expect(
      messages.find((message) => message.title.includes('committed secret'))!
        .detail,
    ).toContain('Not blocking on this branch');
  });

  it('keeps an undeterminable licence apart from a forbidden one', () => {
    const messages = translateResults('quality', 'success', {
      findings: { forbiddenLicenses: 0, undeterminedLicenses: 2 },
    });

    // Folding it into the forbidden count would invent a violation; dropping
    // it would clear a dependency on a question nobody answered.
    const undetermined = messages.find((message) =>
      message.title.includes('could not be determined'),
    );
    expect(undetermined).toBeDefined();
    expect(undetermined!.severity).toBe('info');
    expect(
      messages.filter((message) => message.title.includes('forbidden licence')),
    ).toHaveLength(0);
  });

  it('says nothing when every gate is clean', () => {
    const messages = translateResults('quality', 'success', {
      findings: { secrets: 0, forbiddenLicenses: 0, sbomComponents: 51 },
    });

    expect(
      messages.filter(
        (message) =>
          message.title.includes('secret') || message.title.includes('licence'),
      ),
    ).toHaveLength(0);
  });
});

/*
 * A setting stopped the analysis, so the code was never judged.
 *
 * Automatic Analysis is on by default for every new SonarCloud project, and
 * the organisation-level switch that would disable it is Enterprise-only — so
 * this is not one project's quirk, it is what every project meets on its first
 * run. The reason cannot arrive as an annotation either: a workflow-level
 * error is attributed to `.github`, and those are filtered out.
 */
describe('translateResults — SonarCloud blocked by a setting', () => {
  it('names the setting and where to change it', () => {
    const messages = translateResults('quality', 'failure', {
      sonar: { blockedBy: 'automatic-analysis' },
    });

    const blocked = messages.find((message) =>
      message.title.includes('analyse this project itself'),
    );

    expect(blocked).toBeDefined();
    expect(blocked!.severity).toBe('error');
    expect(blocked!.hint).toContain('Analysis Method');
    expect(blocked!.detail).toContain('not analysed');
  });

  /*
   * It has to lead. A gate status or a measure count from a scanner that
   * refused to start is stale or absent, and reporting it first sends the
   * reader to fix code nobody looked at.
   */
  it('does not also report a gate the scanner never reached', () => {
    const messages = translateResults('quality', 'failure', {
      sonar: {
        blockedBy: 'automatic-analysis',
        gate: 'UNKNOWN',
        measures: { bugs: '4' },
      },
    });

    expect(
      messages.filter((message) => message.title.includes('could not be read')),
    ).toHaveLength(0);
    expect(
      messages.filter((message) => message.title === 'SonarCloud findings'),
    ).toHaveLength(0);
  });

  it('keeps reporting normally when nothing blocked it', () => {
    const messages = translateResults('quality', 'failure', {
      sonar: {
        gate: 'ERROR',
        failedConditions: [
          { metric: 'new_coverage', actual: '61.2', threshold: '80' },
        ],
      },
    });

    expect(
      messages.filter((message) =>
        message.title.includes('analyse this project itself'),
      ),
    ).toHaveLength(0);
    expect(
      messages.find((message) => message.title.includes('quality gate failed')),
    ).toBeDefined();
  });
});
