import type { GitHubRepositoryEvent } from '#kernel/ports/github.port';
import {
  isRelevantGithubEvent,
  mapGithubEvent,
  pullRequestNumberOf,
  pushNeedsCompare,
} from './github-activity.mapper';

const REPO = 'Alphaexplora-Sandbox/logistics2cicd-be';

const event = (
  type: string,
  payload: Record<string, unknown>,
  id = '100',
): GitHubRepositoryEvent => ({
  id,
  type,
  actor: { login: 'LloydLim1' },
  createdAt: '2026-10-02T14:53:18Z',
  payload,
});

const SHA_A = 'be27b42a513caeac665a14e773891b1111b74004';
const SHA_B = '79533a7c3f49fea08efaacc37e07e4efaa505cf3';

describe('GitHub event mapping', () => {
  describe('PushEvent', () => {
    const push = event('PushEvent', {
      ref: 'refs/heads/dev',
      before: SHA_A,
      head: SHA_B,
    });

    it('maps the minimal payload GitHub sends today to github.push', () => {
      expect(mapGithubEvent(push, REPO)).toEqual({
        externalId: 'github:100',
        eventCode: 'github.push',
        message: 'Pushed to dev',
        actorLogin: 'LloydLim1',
        occurredAt: '2026-10-02T14:53:18Z',
        metadata: {
          branch: 'dev',
          before: SHA_A,
          head: SHA_B,
          size: null,
          commits: [],
          forced: false,
          url: `https://github.com/${REPO}/compare/${SHA_A}...${SHA_B}`,
          githubLogin: 'LloydLim1',
        },
      });
    });

    it('uses the compare result: count, first lines, max 20 commits', () => {
      const commits = Array.from({ length: 25 }, (_, i) => ({
        sha: `sha${String(i)}`,
        message: `fix ${String(i)}\n\nlong body`,
        authorName: 'Dev',
      }));

      const mapped = mapGithubEvent(push, REPO, {
        push: { status: 'ahead', totalCommits: 25, commits },
      });

      expect(mapped?.message).toBe('Pushed 25 commits to dev');
      const meta = mapped?.metadata as {
        commits: Array<{ message: string }>;
        forced: boolean;
        size: number;
      };
      expect(meta.size).toBe(25);
      expect(meta.commits).toHaveLength(20);
      expect(meta.commits[0]?.message).toBe('fix 0');
      expect(meta.forced).toBe(false);
    });

    it('says commit in the singular', () => {
      expect(
        mapGithubEvent(push, REPO, {
          push: {
            status: 'ahead',
            totalCommits: 1,
            commits: [{ sha: 's', message: 'm', authorName: 'a' }],
          },
        })?.message,
      ).toBe('Pushed 1 commit to dev');
    });

    it('marks a push whose old head is not an ancestor as forced', () => {
      const mapped = mapGithubEvent(push, REPO, {
        push: { status: 'diverged', totalCommits: 2, commits: [] },
      });

      expect(mapped?.message).toBe('Force-pushed 2 commits to dev');
      expect(mapped?.metadata['forced']).toBe(true);
    });

    it('links a new branch to its head commit and needs no compare', () => {
      const created = event('PushEvent', {
        ref: 'refs/heads/feature/x',
        before: '0'.repeat(40),
        head: SHA_B,
      });

      expect(pushNeedsCompare(created)).toBe(false);
      expect(pushNeedsCompare(push)).toBe(true);
      expect(mapGithubEvent(created, REPO)?.metadata['url']).toBe(
        `https://github.com/${REPO}/commit/${SHA_B}`,
      );
    });

    it('ignores tag pushes (the CreateEvent reports the tag)', () => {
      expect(
        mapGithubEvent(
          event('PushEvent', {
            ref: 'refs/tags/v1',
            before: SHA_A,
            head: SHA_B,
          }),
          REPO,
        ),
      ).toBeNull();
    });
  });

  describe('PullRequestEvent', () => {
    const pr = (action: string, extra: Record<string, unknown> = {}) =>
      event('PullRequestEvent', {
        action,
        number: 1,
        pull_request: {
          number: 1,
          head: { ref: 'dev' },
          base: { ref: 'uat' },
          ...extra,
        },
      });

    it.each([
      ['opened', 'github.pull_request.opened', 'Opened'],
      ['reopened', 'github.pull_request.reopened', 'Reopened'],
      ['merged', 'github.pull_request.merged', 'Merged'],
    ])('maps %s', (action, code, verb) => {
      const mapped = mapGithubEvent(pr(action), REPO);

      expect(mapped?.eventCode).toBe(code);
      expect(mapped?.message).toBe(`${verb} pull request #1 (dev into uat)`);
      expect(mapped?.metadata).toMatchObject({
        number: 1,
        base: 'uat',
        head: 'dev',
        url: `https://github.com/${REPO}/pull/1`,
        githubLogin: 'LloydLim1',
      });
    });

    it('adds the title and merger from the pull request lookup', () => {
      const mapped = mapGithubEvent(pr('merged'), REPO, {
        pullRequest: {
          title: 'Promote DEV to UAT',
          merged: true,
          mergedByLogin: 'lead',
          htmlUrl: 'x',
        },
      });

      expect(mapped?.message).toBe(
        'Merged pull request #1 "Promote DEV to UAT" (dev into uat)',
      );
      expect(mapped?.metadata).toMatchObject({
        title: 'Promote DEV to UAT',
        merged_by: 'lead',
      });
    });

    it('tells a merge from a plain close using the lookup', () => {
      expect(mapGithubEvent(pr('closed'), REPO)?.eventCode).toBe(
        'github.pull_request.closed',
      );
      expect(
        mapGithubEvent(pr('closed'), REPO, {
          pullRequest: {
            title: 't',
            merged: true,
            mergedByLogin: null,
            htmlUrl: '',
          },
        })?.eventCode,
      ).toBe('github.pull_request.merged');
      expect(
        mapGithubEvent(pr('closed', { merged: true }), REPO)?.eventCode,
      ).toBe('github.pull_request.merged');
    });

    it('ignores actions that are not opened, closed, merged or reopened', () => {
      for (const action of ['labeled', 'synchronize', 'assigned', 'edited']) {
        expect(mapGithubEvent(pr(action), REPO)).toBeNull();
      }
    });

    it('reads the number from the event or the pull request', () => {
      expect(pullRequestNumberOf(pr('opened'))).toBe(1);
      expect(
        pullRequestNumberOf(
          event('PullRequestEvent', {
            action: 'opened',
            pull_request: { number: 7 },
          }),
        ),
      ).toBe(7);
      expect(pullRequestNumberOf(event('PushEvent', {}))).toBeNull();
    });
  });

  describe('PullRequestReviewEvent', () => {
    it('maps a submitted review with its state', () => {
      const mapped = mapGithubEvent(
        event('PullRequestReviewEvent', {
          action: 'submitted',
          pull_request: { number: 4 },
          review: { state: 'CHANGES_REQUESTED' },
        }),
        REPO,
      );

      expect(mapped?.eventCode).toBe('github.pull_request.reviewed');
      expect(mapped?.message).toBe(
        'Reviewed pull request #4 (changes requested)',
      );
      expect(mapped?.metadata).toMatchObject({
        number: 4,
        state: 'changes_requested',
      });
    });

    it('ignores edits and dismissals', () => {
      expect(
        mapGithubEvent(
          event('PullRequestReviewEvent', {
            action: 'dismissed',
            pull_request: { number: 4 },
          }),
          REPO,
        ),
      ).toBeNull();
    });
  });

  describe('CreateEvent / DeleteEvent', () => {
    it.each([
      ['CreateEvent', 'branch', 'github.branch.created', 'Created branch x'],
      ['DeleteEvent', 'branch', 'github.branch.deleted', 'Deleted branch x'],
      ['CreateEvent', 'tag', 'github.tag.created', 'Created tag x'],
      ['DeleteEvent', 'tag', 'github.tag.deleted', 'Deleted tag x'],
    ])('%s %s', (type, refType, code, message) => {
      const mapped = mapGithubEvent(
        event(type, { ref: 'x', ref_type: refType }),
        REPO,
      );

      expect(mapped).toMatchObject({ eventCode: code, message });
      expect(mapped?.metadata).toMatchObject({ ref: 'x', refType });
    });

    it('ignores repository creation', () => {
      expect(
        mapGithubEvent(
          event('CreateEvent', { ref: null, ref_type: 'repository' }),
          REPO,
        ),
      ).toBeNull();
    });
  });

  it('ignores every other event type', () => {
    for (const type of ['IssueCommentEvent', 'WatchEvent', 'ForkEvent']) {
      const other = event(type, {});
      expect(mapGithubEvent(other, REPO)).toBeNull();
      expect(isRelevantGithubEvent(other)).toBe(false);
    }
  });

  it('keys the dedupe id by the GitHub event id and keeps the actor in metadata', () => {
    const mapped = mapGithubEvent(
      event('CreateEvent', { ref: 'x', ref_type: 'branch' }, '22798151147'),
      REPO,
    );

    expect(mapped?.externalId).toBe('github:22798151147');
    expect(mapped?.metadata['githubLogin']).toBe('LloydLim1');
    expect(mapped?.occurredAt).toBe('2026-10-02T14:53:18Z');
  });
});
