import {
  COMPARE_FILE_LIMIT,
  encodeRef,
  toBranchComparison,
  validationMessage,
} from './github-workspace.mapping.js';

describe('toBranchComparison', () => {
  it('maps counts, commit headlines and files', () => {
    const result = toBranchComparison({
      status: 'ahead',
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      commits: [
        {
          sha: 'abc',
          commit: {
            message: 'feat: add login\n\nLonger body that is not shown.',
            author: { name: 'Lloyd', date: '2026-09-24T00:00:00Z' },
          },
          author: { login: 'lloydlim1' },
        },
      ],
      files: [{ filename: 'a.ts', status: 'added', additions: 3, patch: '@@' }],
    });

    expect(result).toEqual({
      status: 'ahead',
      aheadBy: 2,
      behindBy: 0,
      totalCommits: 2,
      commits: [
        {
          sha: 'abc',
          headline: 'feat: add login',
          author: 'lloydlim1',
          authoredAt: '2026-09-24T00:00:00Z',
        },
      ],
      files: [
        {
          filename: 'a.ts',
          status: 'added',
          additions: 3,
          deletions: 0,
          changes: 0,
          patch: '@@',
        },
      ],
      filesTruncated: false,
    });
  });

  it('names an author with no linked GitHub account by their git name', () => {
    const result = toBranchComparison({
      commits: [
        { sha: 'x', commit: { message: 'm', author: { name: 'Ann' } } },
      ],
    });
    expect(result.commits[0]?.author).toBe('Ann');
  });

  it('reads an unknown status as diverged rather than identical, so a change is never hidden', () => {
    expect(toBranchComparison({ status: 'something-new' }).status).toBe(
      'diverged',
    );
  });

  it("flags the file list as truncated at GitHub's comparison cap", () => {
    const files = Array.from({ length: COMPARE_FILE_LIMIT }, (_, i) => ({
      filename: `f${String(i)}.ts`,
    }));
    expect(toBranchComparison({ files }).filesTruncated).toBe(true);
  });
});

describe('encodeRef', () => {
  it('keeps slashes so a nested branch name resolves as one ref', () => {
    expect(encodeRef('feature/login')).toBe('feature/login');
  });

  it('encodes characters that would end the path', () => {
    expect(encodeRef('fix#12 now')).toBe('fix%2312%20now');
  });
});

describe('validationMessage', () => {
  it("prefers the sentence inside errors over GitHub's generic top line", () => {
    expect(
      validationMessage(
        JSON.stringify({
          message: 'Validation Failed',
          errors: [
            {
              resource: 'PullRequest',
              code: 'custom',
              message: 'A pull request already exists for org:feature.',
            },
          ],
        }),
      ),
    ).toBe('A pull request already exists for org:feature.');
  });

  it('spells out a field error that carries no message', () => {
    expect(
      validationMessage(
        JSON.stringify({
          message: 'Validation Failed',
          errors: [{ field: 'head', code: 'invalid' }],
        }),
      ),
    ).toBe('head is invalid');
  });

  it('falls back to the top-level message, then to the raw body', () => {
    expect(validationMessage(JSON.stringify({ message: 'Nope' }))).toBe('Nope');
    expect(validationMessage('not json')).toBe('not json');
  });
});
