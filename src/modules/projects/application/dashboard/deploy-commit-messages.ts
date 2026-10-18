import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  GITHUB_PROJECT_PORT,
  type GithubProjectPort,
} from '#kernel/ports/github.port';
import { ProjectGithubTokenResolver } from '../github-activity/project-github-token.resolver';

/** How far back a branch is read: comfortably more than its recent deploys. */
const COMMITS_READ = 50;
/** Long enough to share between viewers of one Overview, short enough to see a new push. */
const CACHE_TTL_MS = 60_000;

interface CachedMessages {
  at: number;
  messages: Promise<Map<string, string>>;
}

/**
 * First lines of commit messages for deploys whose provider did not send one.
 *
 * A Render image deploy knows its commit only from the image tag, so the
 * Overview would show a bare SHA. One read of the branch's recent commits
 * names them all; it uses the repository's installation token (the Overview is
 * not the caller's personal view of the code) and is cached per branch. A
 * failed read leaves the messages out, never the deploys.
 */
@Injectable()
export class DeployCommitMessages {
  private readonly logger = new Logger(DeployCommitMessages.name);
  private readonly cache = new Map<string, CachedMessages>();

  constructor(
    @Inject(GITHUB_PROJECT_PORT)
    private readonly github: GithubProjectPort,
    private readonly tokens: ProjectGithubTokenResolver,
  ) {}

  async forBranch(
    repoFullName: string,
    userId: string,
    branch: string,
  ): Promise<Map<string, string>> {
    const key = `${repoFullName.toLowerCase()}::${branch}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.messages;
    }
    const messages = this.read(repoFullName, userId, branch);
    this.cache.set(key, { at: Date.now(), messages });
    return messages;
  }

  private async read(
    repoFullName: string,
    userId: string,
    branch: string,
  ): Promise<Map<string, string>> {
    try {
      const token = await this.tokens.installationFirst(
        repoFullName,
        userId,
        null,
      );
      if (!token) return new Map();
      const page = await this.github.listCommits(token, repoFullName, {
        branch,
        perPage: COMMITS_READ,
        page: 1,
      });
      return new Map(
        page.items.map((commit) => [
          commit.sha.toLowerCase(),
          (commit.message.split(/\r?\n/, 1)[0] ?? '').trim(),
        ]),
      );
    } catch (error) {
      this.logger.debug(
        `Commit messages for ${repoFullName}@${branch} were not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Map();
    }
  }
}

/** The message for a full or abbreviated SHA, when the branch read has it. */
export function messageFor(
  messages: Map<string, string>,
  sha: string | null,
): string | null {
  if (!sha) return null;
  const wanted = sha.toLowerCase();
  const exact = messages.get(wanted);
  if (exact !== undefined) return exact || null;
  for (const [full, message] of messages) {
    if (full.startsWith(wanted)) return message || null;
  }
  return null;
}
