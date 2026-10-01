import { buildQaPromotionPullRequestBody } from './qa-promotion.pr-body';
import type { QaPromotionChecklist } from './qa-promotion.contracts';

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const checklist = (
  overrides: Partial<QaPromotionChecklist> = {},
): QaPromotionChecklist => ({
  id: 'checklist-1',
  name: 'Release checklist',
  runId: 'run-1',
  verdict: 'APPROVED',
  runStatus: 'signed_off',
  approvedForHead: true,
  ...overrides,
});

describe('buildQaPromotionPullRequestBody', () => {
  it('lists each checklist with its run id, verdict and the short sha', () => {
    const body = buildQaPromotionPullRequestBody(
      [
        checklist({ id: 'c1', name: 'Release checklist', runId: 'run-1' }),
        checklist({ id: 'c2', name: 'Smoke checklist', runId: 'run-2' }),
      ],
      SHA,
    );

    expect(body).toContain('Promoting `uat` (a1b2c3d) to `main`.');
    expect(body).toContain(
      '- **Release checklist** — run run-1, APPROVED (a1b2c3d)',
    );
    expect(body).toContain(
      '- **Smoke checklist** — run run-2, APPROVED (a1b2c3d)',
    );
  });

  it('falls back to "unknown" for a null runId or verdict rather than throwing', () => {
    const body = buildQaPromotionPullRequestBody(
      [checklist({ runId: null, verdict: null })],
      SHA,
    );

    expect(body).toContain('run unknown, unknown (a1b2c3d)');
  });

  it('lists the Project run and every repository it captured', () => {
    const body = buildQaPromotionPullRequestBody([checklist()], SHA, {
      runId: 'run-9',
      repositories: [
        { repoFullName: 'acme/api', runSha: SHA },
        { repoFullName: 'acme/web', runSha: null },
      ],
    });

    expect(body).toContain('Project run run-9 covered:');
    expect(body).toContain('- `acme/api` @ a1b2c3d');
    expect(body).toContain('- `acme/web` @ unknown');
  });
});
