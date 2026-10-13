import {
  cleanMessages,
  reclassifyStoredFailure,
  stripAnsi,
  translateResults,
  type CiResults,
} from './translate-results';

const ESC = String.fromCharCode(27);
const jobLine = (...names: string[]) =>
  names.map((name) => `Failed GitHub Actions job: ${name}`).join('\n');

describe('translateResults: verify failures are not test failures', () => {
  const first = (name: string) =>
    translateResults('verify', 'failure', {}, jobLine(name))[0]!;

  it('says the deployment never became healthy when the wait step failed', () => {
    const message = first(
      'api-tests-uat / API Tests (orders-api) > Wait For Deployment',
    );

    expect(message.title).toBe('The deployment never became healthy');
    expect(message.hint).not.toContain('Run the failing test command');
    expect(message.items?.[0]?.label).toContain('Wait For Deployment');
  });

  it('says no OpenAPI document was found when the schema step failed', () => {
    const message = first(
      'contract-tests-uat / Schemathesis (orders-api) > Locate Schema',
    );

    expect(message.title).toBe('No OpenAPI document found');
    expect(message.hint).toContain('OpenAPI');
    expect(message.hint).not.toContain('Run the failing test command');
  });

  it('says the service could not be located when the resolver failed', () => {
    expect(first('resolve-targets / Resolve deployment targets').title).toBe(
      'The deployed service could not be located',
    );
  });

  it('still calls a genuinely failed request a test failure, with verify-specific advice', () => {
    const message = first(
      'api-tests-uat / API Tests (orders-api) > Run Bruno collection',
    );

    expect(message.title).toBe('Post-deploy tests failed');
    expect(message.hint).toContain('deployed service');
    expect(message.hint).not.toContain('locally');
  });

  it('keeps the quality-stage copy for a unit-test job', () => {
    const message = translateResults(
      'quality',
      'failure',
      {},
      jobLine('dotnet-tests / .NET Unit Tests'),
    )[0]!;

    expect(message.title).toBe('Tests failed');
  });

  it('explains a failed promotion rather than calling it an unknown job', () => {
    const message = translateResults(
      'package',
      'failure',
      {},
      jobLine('promote-to-main / Create Promotion PR'),
    )[0]!;

    expect(message.title).toBe(
      'The promotion pull request could not be created',
    );
  });

  it('does not misread a step name outside verify as a deployment wait', () => {
    const message = translateResults(
      'quality',
      'failure',
      {},
      jobLine('dotnet-tests / .NET Unit Tests > Wait For Deployment'),
    )[0]!;

    expect(message.title).toBe('Tests failed');
  });
});

describe('translateResults: a workflow ::error:: is shown as the reason', () => {
  it('leads with the message and no .github location', () => {
    const messages = translateResults(
      'package',
      'failure',
      {},
      jobLine('deploy-render-backend-uat / Deploy to Render > Release'),
      [
        {
          path: '.github',
          line: 12,
          level: 'failure',
          message:
            'AlphaCI refused the release (HTTP 502): Render could not pull the image.',
        },
      ],
    );

    const item = messages[0]!.items![0]!;
    expect(item.label).toBe(
      'AlphaCI refused the release (HTTP 502): Render could not pull the image.',
    );
    expect(item.sub).toBeUndefined();
    expect(messages[0]!.title).toBe('Image or deployment step failed');
  });
});

describe('translateResults: every failed job is listed', () => {
  const sonarFailed: CiResults = {
    sonar: {
      gate: 'ERROR',
      failedConditions: [{ metric: 'new_coverage', actual: '40' }],
    },
  };

  it('lists the licence and lint jobs that failed beside a Sonar failure', () => {
    const messages = translateResults(
      'quality',
      'failure',
      sonarFailed,
      jobLine(
        'sonar / SonarCloud Analysis',
        'licenses / License Scan',
        'lint / Lint (orders)',
      ),
    );

    const others = messages.find((m) => m.title.includes('other jobs failed'));
    expect(others).toBeDefined();
    expect(others!.severity).toBe('error');
    expect(others!.items!.map((i) => i.label)).toEqual([
      'licenses / License Scan',
      'lint / Lint (orders)',
    ]);
  });

  it('does not list the job a message above already accounts for', () => {
    const messages = translateResults(
      'quality',
      'failure',
      sonarFailed,
      jobLine('sonar / SonarCloud Analysis'),
    );

    expect(messages.some((m) => m.title.includes('other'))).toBe(false);
    expect(
      messages.some((m) => m.items?.some((i) => i.label.includes('sonar /'))),
    ).toBe(false);
  });

  it('names a single leftover job with its own copy', () => {
    const messages = translateResults(
      'quality',
      'failure',
      { tests: { passed: 3, failed: 1, total: 4 } },
      jobLine('backend-tests / Tests', 'lint / Lint (orders)'),
    );

    const other = messages.find((m) => m.title === 'Lint check failed');
    expect(other?.items?.map((i) => i.label)).toEqual(['lint / Lint (orders)']);
  });

  it('works from the per-tool list when no failed job name was captured', () => {
    const messages = translateResults('quality', 'failure', {
      ...sonarFailed,
      checks: [
        { name: 'sonar / SonarCloud Analysis', conclusion: 'failure' },
        { name: 'licenses / License Scan', conclusion: 'failure' },
        { name: 'lint / Lint (orders)', conclusion: 'success' },
      ],
    });

    const others = messages.find((m) => m.detail.includes('accounts for it'));
    expect(others?.items?.map((i) => i.label)).toEqual([
      'licenses / License Scan',
    ]);
  });

  it('adds nothing on a stage that passed', () => {
    const messages = translateResults('quality', 'success', {
      checks: [{ name: 'lint / Lint', conclusion: 'failure' }],
    });

    expect(messages.some((m) => m.severity === 'error')).toBe(false);
  });
});

describe('translateResults: high-severity vulnerabilities', () => {
  const security: CiResults = {
    security: {
      high: 2,
      critical: 0,
      items: [{ package: 'lodash', severity: 'high' }],
    },
  };

  it('is an error when the blocking audit job failed', () => {
    const messages = translateResults(
      'quality',
      'failure',
      security,
      jobLine('security / Dependency Audit'),
    );

    const high = messages.find((m) => m.title.includes('high-severity'));
    expect(high?.severity).toBe('error');
    // It explains the failure, so the audit job is not listed a second time.
    expect(messages.some((m) => m.title.includes('other'))).toBe(false);
  });

  it('recognises the failed audit from the per-tool list alone', () => {
    const messages = translateResults('quality', 'failure', {
      ...security,
      checks: [{ name: 'security / Dependency Audit', conclusion: 'failure' }],
    });

    expect(
      messages.find((m) => m.title.includes('high-severity'))?.severity,
    ).toBe('error');
  });

  it('stays a warning where the audit passed (advisory on dev)', () => {
    const messages = translateResults('quality', 'success', security);

    expect(
      messages.find((m) => m.title.includes('high-severity'))?.severity,
    ).toBe('warning');
  });

  it('stays a warning when the stage failed for another reason', () => {
    const messages = translateResults(
      'quality',
      'failure',
      security,
      jobLine('lint / Lint'),
    );

    expect(
      messages.find((m) => m.title.includes('high-severity'))?.severity,
    ).toBe('warning');
  });
});

describe('translateResults: no null line numbers', () => {
  it('omits a null annotation line', () => {
    const messages = translateResults('quality', 'failure', {}, undefined, [
      {
        path: 'Program.cs',
        line: null,
        message: 'Await RunAsync instead of blocking',
        level: 'warning',
      },
    ]);

    const item = messages[0]!.items![0]!;
    expect(item.label).toBe('Program.cs');
    expect(JSON.stringify(messages)).not.toContain('null');
  });

  it('keeps a real line number', () => {
    const messages = translateResults('quality', 'failure', {}, undefined, [
      { path: 'Program.cs', line: 11, message: 'x' },
    ]);

    expect(messages[0]!.items![0]!.label).toBe('Program.cs:11');
  });

  it('omits a null lint line and a null secret line', () => {
    // The wire carries `null`, which the declared types do not admit.
    const results = {
      lint: {
        errors: 1,
        warnings: 0,
        issues: [{ rule: 'no-unused-vars', file: 'a.ts', line: null }],
      },
      findings: {
        secrets: 1,
        secretItems: [{ rule: 'aws-key', file: 'b.ts', line: null }],
      },
    } as unknown as CiResults;

    const text = JSON.stringify(
      translateResults('quality', 'failure', results),
    );

    expect(text).not.toContain(':null');
    expect(text).toContain('"sub":"a.ts"');
    expect(text).toContain('"label":"b.ts"');
  });
});

describe('ANSI escape codes', () => {
  it('stripAnsi removes colour and style sequences and nothing else', () => {
    expect(
      stripAnsi(`${ESC}[31mred${ESC}[39m ${ESC}[1;4mbold${ESC}[0m [x]`),
    ).toBe('red bold [x]');
  });

  it('are stripped from the messages built from test failures', () => {
    const messages = translateResults('quality', 'failure', {
      tests: {
        passed: 0,
        failed: 1,
        total: 1,
        failures: [
          {
            name: 'home page loads',
            message: `${ESC}[2mexpect(${ESC}[22m${ESC}[31mpage${ESC}[39m).toHaveTitle`,
          },
        ],
      },
    });

    expect(messages[0]!.items![0]!.sub).toBe('expect(page).toHaveTitle');
    expect(JSON.stringify(messages)).not.toContain(ESC);
  });

  it('are stripped from annotations too', () => {
    const messages = translateResults('quality', 'failure', {}, undefined, [
      { path: 'a.ts', line: 1, message: `${ESC}[31mboom${ESC}[39m` },
    ]);

    expect(messages[0]!.items![0]!.sub).toBe('boom');
  });

  it('cleanMessages is idempotent', () => {
    const once = cleanMessages([
      {
        severity: 'error',
        title: `${ESC}[1mt${ESC}[22m`,
        detail: 'd',
        hint: 'h',
        items: [{ label: 'x:null' }],
      },
    ]);

    expect(cleanMessages(once)).toEqual(once);
    expect(once[0]!.items![0]!.label).toBe('x');
  });
});

describe('translateResults: a stage skipped on purpose', () => {
  it('shows the reason as information, not as a result or a failure', () => {
    const messages = translateResults('verify', 'success', {
      skipped: {
        reason:
          'Nothing was deployed for uat: VERCEL_ALIAS is not set - provision hosting in ALPHACI.',
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      severity: 'info',
      title: 'Not run',
    });
    expect(messages[0]!.detail).toContain('provision hosting in ALPHACI');
  });
});

describe('reclassifyStoredFailure', () => {
  const stored = [
    {
      severity: 'error' as const,
      title: 'Tests failed',
      detail: 'd',
      hint: 'Run the failing test command locally',
    },
  ];

  it('relabels the stale copy for a deployment that never came up', () => {
    const [message] = reclassifyStoredFailure(
      'verify',
      stored,
      jobLine('api-tests-uat / API Tests (x) > Wait For Deployment'),
    );

    expect(message!.title).toBe('The deployment never became healthy');
  });

  it('does nothing without a failed job name, or for another stage', () => {
    expect(reclassifyStoredFailure('verify', stored, null)).toEqual(stored);
    expect(
      reclassifyStoredFailure(
        'quality',
        stored,
        jobLine('api-tests-uat / API Tests (x) > Wait For Deployment'),
      ),
    ).toEqual(stored);
  });
});
