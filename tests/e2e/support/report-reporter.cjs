// Writes the repeatable E2E artifact: artifacts/e2e/<commit>/report.json.
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');

// First meaningful line of a Jest failure, without terminal colour codes.
const firstLine = (text) =>
  String(text ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) ?? null;

class E2eReportReporter {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
  }

  onRunComplete(_contexts, results) {
    const git = (args) =>
      execFileSync('git', args, { cwd: this.rootDir, encoding: 'utf8' }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    const compose = readFileSync(
      join(this.rootDir, 'tests', 'integration', 'database', 'compose.yaml'),
      'utf8',
    );

    const scenarios = results.testResults.flatMap((file) => {
      const path = relative(this.rootDir, file.testFilePath).replaceAll(
        '\\',
        '/',
      );
      const tests = file.testResults.map((test) => ({
        file: path,
        name: test.fullName,
        status: test.status,
        durationMs: test.duration ?? null,
        failure: firstLine(test.failureMessages[0]),
      }));
      if (!file.testExecError) return tests;
      return [
        ...tests,
        {
          file: path,
          name: '(test file error)',
          status: 'failed',
          durationMs: null,
          failure: firstLine(file.testExecError.message),
        },
      ];
    });

    const report = {
      schemaVersion: 1,
      commit,
      dirty: git(['status', '--porcelain']).length > 0,
      generatedAt: new Date().toISOString(),
      command: 'npm run test:e2e',
      node: process.version,
      database: {
        image: /image:\s*(\S+)/.exec(compose)?.[1] ?? 'unknown',
        source: process.env.E2E_DATABASE_URL
          ? 'E2E_DATABASE_URL (loopback)'
          : 'tests/integration/database/compose.yaml',
      },
      summary: {
        total: results.numTotalTests,
        passed: results.numPassedTests,
        failed: results.numFailedTests + results.numRuntimeErrorTestSuites,
        skipped: results.numPendingTests + results.numTodoTests,
      },
      success: results.success,
      scenarios,
    };

    const directory = join(this.rootDir, 'artifacts', 'e2e', commit);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'report.json');
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write('E2E report: ' + relative(this.rootDir, path) + '\n');
  }
}

module.exports = E2eReportReporter;
