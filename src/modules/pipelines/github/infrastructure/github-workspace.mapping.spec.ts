import {
  MAX_FILE_BYTES,
  mapContentEntries,
  toFileListing,
  toPullRequestSummary,
} from './github-workspace.mapping.js';

describe('toPullRequestSummary', () => {
  it('maps a fully populated pull request', () => {
    expect(
      toPullRequestSummary({
        number: 12,
        title: 'Add workspace reads',
        state: 'open',
        draft: false,
        merged_at: null,
        html_url: 'https://github.com/org/repo/pull/12',
        head: { ref: 'feature' },
        base: { ref: 'main' },
        user: { login: 'tone', avatar_url: 'https://avatars.example/tone' },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        additions: 10,
        deletions: 2,
        changed_files: 3,
      }),
    ).toEqual({
      number: 12,
      title: 'Add workspace reads',
      state: 'open',
      draft: false,
      merged: false,
      htmlUrl: 'https://github.com/org/repo/pull/12',
      headRef: 'feature',
      baseRef: 'main',
      author: 'tone',
      authorAvatarUrl: 'https://avatars.example/tone',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
    });
  });

  it('treats draft as true only when draft is exactly true', () => {
    expect(toPullRequestSummary({ number: 1, draft: true }).draft).toBe(true);
    expect(toPullRequestSummary({ number: 1, draft: false }).draft).toBe(false);
    expect(toPullRequestSummary({ number: 1 }).draft).toBe(false);
  });

  it('treats merged as true only when merged_at is present', () => {
    expect(
      toPullRequestSummary({
        number: 1,
        merged_at: '2026-03-01T00:00:00Z',
      }).merged,
    ).toBe(true);
    expect(toPullRequestSummary({ number: 1, merged_at: null }).merged).toBe(
      false,
    );
    expect(toPullRequestSummary({ number: 1 }).merged).toBe(false);
  });

  it('fills missing optional fields with empty strings and nulls', () => {
    expect(toPullRequestSummary({ number: 42 })).toEqual({
      number: 42,
      title: '',
      state: 'open',
      draft: false,
      merged: false,
      htmlUrl: '',
      headRef: '',
      baseRef: '',
      author: null,
      authorAvatarUrl: null,
      createdAt: '',
      updatedAt: '',
      additions: null,
      deletions: null,
      changedFiles: null,
    });
  });

  it('maps closed state from GitHub and leaves any other state as open', () => {
    expect(toPullRequestSummary({ number: 1, state: 'closed' }).state).toBe(
      'closed',
    );
    expect(toPullRequestSummary({ number: 1, state: 'open' }).state).toBe(
      'open',
    );
    expect(toPullRequestSummary({ number: 1, state: 'merged' }).state).toBe(
      'open',
    );
  });
});

describe('mapContentEntries', () => {
  it('maps rows and sorts directories first, then alphabetically', () => {
    expect(
      mapContentEntries([
        { name: 'z.txt', path: 'z.txt', type: 'file', size: 3, sha: 'a' },
        { name: 'src', path: 'src', type: 'dir', size: 0, sha: 'b' },
        { name: 'app.ts', path: 'app.ts', type: 'file', size: 10, sha: 'c' },
        { name: 'lib', path: 'lib', type: 'dir', size: 0, sha: 'd' },
      ]),
    ).toEqual([
      { name: 'lib', path: 'lib', type: 'dir', size: 0, sha: 'd' },
      { name: 'src', path: 'src', type: 'dir', size: 0, sha: 'b' },
      { name: 'app.ts', path: 'app.ts', type: 'file', size: 10, sha: 'c' },
      { name: 'z.txt', path: 'z.txt', type: 'file', size: 3, sha: 'a' },
    ]);
  });

  it('fills missing optional fields with empty strings, file type, and zero size', () => {
    expect(mapContentEntries([{}])).toEqual([
      { name: '', path: '', type: 'file', size: 0, sha: '' },
    ]);
  });
});

describe('toFileListing', () => {
  it('decodes base64 text and keeps the requested ref', () => {
    expect(
      toFileListing(
        {
          name: 'readme.md',
          path: 'docs/readme.md',
          size: 5,
          sha: 'abc',
          encoding: 'base64',
          content: Buffer.from('hello').toString('base64'),
          html_url: 'https://github.com/org/repo/blob/main/docs/readme.md',
        },
        'docs/readme.md',
        'main',
      ),
    ).toEqual({
      path: 'docs/readme.md',
      ref: 'main',
      entries: [],
      file: {
        name: 'readme.md',
        path: 'docs/readme.md',
        size: 5,
        sha: 'abc',
        content: 'hello',
        truncated: false,
        htmlUrl: 'https://github.com/org/repo/blob/main/docs/readme.md',
      },
    });
  });

  it('reports binary blobs as truncated instead of decoding them', () => {
    const listing = toFileListing(
      {
        name: 'icon.png',
        path: 'icon.png',
        size: 4,
        sha: 'bin',
        encoding: 'base64',
        content: Buffer.from([0x89, 0, 0x50, 0x4e]).toString('base64'),
      },
      'icon.png',
      'main',
    );

    expect(listing.file?.content).toBeNull();
    expect(listing.file?.truncated).toBe(true);
  });

  it('reports oversized files as truncated and falls back to the clean path', () => {
    const listing = toFileListing(
      {
        size: MAX_FILE_BYTES + 1,
        encoding: 'base64',
        content: Buffer.from('too-big').toString('base64'),
      },
      'big.bin',
      'develop',
    );

    expect(listing).toEqual({
      path: 'big.bin',
      ref: 'develop',
      entries: [],
      file: {
        name: 'big.bin',
        path: 'big.bin',
        size: MAX_FILE_BYTES + 1,
        sha: '',
        content: null,
        truncated: true,
        htmlUrl: null,
      },
    });
  });
});
