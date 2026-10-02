import { Logger } from '@nestjs/common';

import { GithubHttp } from './github-http';
import {
  buildPullRequestProtectionPayload,
  ensurePullRequestProtection,
  satisfiesPullRequestPolicy,
} from './github-branch-protection';

const json = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe('pull-request-only branch protection', () => {
  describe('payload', () => {
    it('requires a pull request with zero approvals and blocks force push and deletion on a fresh rule', () => {
      expect(buildPullRequestProtectionPayload(null)).toEqual({
        required_status_checks: null,
        enforce_admins: false,
        required_pull_request_reviews: {
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          required_approving_review_count: 0,
        },
        restrictions: null,
        allow_force_pushes: false,
        allow_deletions: false,
      });
    });

    it('seeds the env-guard check only when the branch has no checks of its own', () => {
      expect(
        buildPullRequestProtectionPayload(null, ['env-guard'])
          .required_status_checks,
      ).toEqual({
        strict: false,
        checks: [{ context: 'env-guard', app_id: -1 }],
      });
    });

    it('keeps the existing required status checks, their apps and strictness, and does not add the seed', () => {
      const payload = buildPullRequestProtectionPayload(
        {
          required_status_checks: {
            strict: true,
            contexts: ['build', 'sonar'],
            checks: [
              { context: 'build', app_id: 15368 },
              { context: 'sonar', app_id: null },
            ],
          },
          allow_force_pushes: { enabled: true },
        },
        ['env-guard'],
      );

      expect(payload['required_status_checks']).toEqual({
        strict: true,
        checks: [
          { context: 'build', app_id: 15368 },
          { context: 'sonar', app_id: -1 },
        ],
      });
      expect(payload['allow_force_pushes']).toBe(false);
    });

    it('falls back to the legacy contexts list when checks are absent', () => {
      expect(
        buildPullRequestProtectionPayload({
          required_status_checks: { strict: false, contexts: ['ci'] },
        })['required_status_checks'],
      ).toEqual({ strict: false, checks: [{ context: 'ci', app_id: -1 }] });
    });

    it('never loosens an existing rule: approvals, code owners, admin enforcement, restrictions and switches are carried over', () => {
      const payload = buildPullRequestProtectionPayload({
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          dismiss_stale_reviews: false,
          require_code_owner_reviews: true,
          required_approving_review_count: 2,
          require_last_push_approval: true,
          dismissal_restrictions: {
            users: [{ login: 'lead' }],
            teams: [{ slug: 'leads' }],
            apps: [],
          },
        },
        restrictions: {
          users: [{ login: 'bot' }],
          teams: [],
          apps: [{ slug: 'alphaci' }],
        },
        required_linear_history: { enabled: true },
        required_conversation_resolution: { enabled: true },
      });

      expect(payload).toMatchObject({
        enforce_admins: true,
        required_pull_request_reviews: {
          dismiss_stale_reviews: false,
          require_code_owner_reviews: true,
          required_approving_review_count: 2,
          require_last_push_approval: true,
          dismissal_restrictions: {
            users: ['lead'],
            teams: ['leads'],
            apps: [],
          },
        },
        restrictions: { users: ['bot'], teams: [], apps: ['alphaci'] },
        required_linear_history: true,
        required_conversation_resolution: true,
        allow_force_pushes: false,
        allow_deletions: false,
      });
    });
  });

  describe('satisfiesPullRequestPolicy', () => {
    it('is true only with a pull request requirement and no force push or deletion', () => {
      expect(satisfiesPullRequestPolicy(null)).toBe(false);
      expect(satisfiesPullRequestPolicy({})).toBe(false);
      expect(
        satisfiesPullRequestPolicy({ required_pull_request_reviews: {} }),
      ).toBe(true);
      expect(
        satisfiesPullRequestPolicy({
          required_pull_request_reviews: {},
          allow_force_pushes: { enabled: true },
        }),
      ).toBe(false);
      expect(
        satisfiesPullRequestPolicy({
          required_pull_request_reviews: {},
          allow_deletions: { enabled: true },
        }),
      ).toBe(false);
    });
  });

  describe('ensurePullRequestProtection', () => {
    let fetchMock: jest.Mock;
    let http: GithubHttp;

    beforeEach(() => {
      fetchMock = jest.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      http = new GithubHttp(new Logger('test'));
    });

    const run = (branch = 'dev', seed: string[] = []) =>
      ensurePullRequestProtection(http, 'tok', 'org', 'repo', branch, {
        seedStatusChecks: seed,
      });

    it('creates the rule on an unprotected branch with a single PUT', async () => {
      fetchMock
        .mockResolvedValueOnce(json(200)) // branch exists
        .mockResolvedValueOnce(json(404, { message: 'Branch not protected' }))
        .mockResolvedValueOnce(json(200));

      await expect(run('dev', ['env-guard'])).resolves.toEqual({
        status: 'applied',
      });

      const [url, init] = fetchMock.mock.calls[2] as [
        string,
        { method: string; body: string },
      ];
      expect(url).toBe(
        'https://api.github.com/repos/org/repo/branches/dev/protection',
      );
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toMatchObject({
        required_pull_request_reviews: { required_approving_review_count: 0 },
        allow_force_pushes: false,
        allow_deletions: false,
        required_status_checks: {
          checks: [{ context: 'env-guard', app_id: -1 }],
        },
      });
    });

    it('merges into an existing rule instead of overwriting it', async () => {
      fetchMock
        .mockResolvedValueOnce(json(200))
        .mockResolvedValueOnce(
          json(200, {
            required_status_checks: {
              strict: true,
              contexts: ['build'],
              checks: [{ context: 'build', app_id: 1 }],
            },
            allow_force_pushes: { enabled: true },
            allow_deletions: { enabled: false },
          }),
        )
        .mockResolvedValueOnce(json(200));

      await expect(run('uat', ['env-guard'])).resolves.toEqual({
        status: 'applied',
      });

      const body = JSON.parse(
        (fetchMock.mock.calls[2] as [string, { body: string }])[1].body,
      ) as { required_status_checks: { checks: unknown[]; strict: boolean } };
      expect(body.required_status_checks).toEqual({
        strict: true,
        checks: [{ context: 'build', app_id: 1 }],
      });
    });

    it('is idempotent: a compliant branch is reported unchanged and not written', async () => {
      fetchMock.mockResolvedValueOnce(json(200)).mockResolvedValueOnce(
        json(200, {
          required_pull_request_reviews: {
            required_approving_review_count: 0,
          },
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false },
        }),
      );

      await expect(run('main')).resolves.toEqual({ status: 'unchanged' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports a branch that does not exist as missing, without touching protection', async () => {
      fetchMock.mockResolvedValueOnce(json(404, { message: 'Not Found' }));

      await expect(run('dev')).resolves.toEqual({ status: 'missing' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('explains a 403 as missing admin permission, per branch', async () => {
      fetchMock
        .mockResolvedValueOnce(json(200))
        .mockResolvedValueOnce(json(404))
        .mockResolvedValueOnce(
          json(403, { message: 'Resource not accessible by integration' }),
        );

      const outcome = await run('uat');

      expect(outcome.status).toBe('failed');
      expect(outcome.error).toContain('HTTP 403');
      expect(outcome.error).toContain('Administration: write');
      expect(outcome.error).toContain('Resource not accessible');
    });

    it('explains a 404 on the protection endpoint the same way', async () => {
      fetchMock
        .mockResolvedValueOnce(json(200))
        .mockResolvedValueOnce(json(404))
        .mockResolvedValueOnce(json(404, { message: 'Not Found' }));

      const outcome = await run('main');

      expect(outcome.status).toBe('failed');
      expect(outcome.error).toContain('lacks admin permission on org/repo');
    });

    it('turns a transport failure into a failed outcome without leaking the token', async () => {
      fetchMock.mockRejectedValueOnce(new Error('socket hang up'));

      const outcome = await run('dev');

      expect(outcome).toEqual({
        status: 'failed',
        error: 'GitHub could not be reached: socket hang up',
      });
      expect(JSON.stringify(outcome)).not.toContain('tok');
    });
  });
});
