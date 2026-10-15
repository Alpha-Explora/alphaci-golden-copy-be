import type {
  GitHubContentEntry,
  GithubProjectPort,
} from '#kernel/ports/github.port';

/**
 * The public AlphaCI API base that generated workflows and repository secrets
 * point at, and the scan that finds committed workflows still naming another.
 *
 * Kept in the kernel because two halves of the product agree on it: the
 * workflow generator writes the base into `.github/workflows`, and drift
 * detection and repair read it back out of committed files. It is resolved at
 * call time, never at import: a value read before `.env` loads is how projects
 * came to carry `http://localhost:4000` in their workflows and secrets.
 */

const DEFAULT_LOCAL_PLATFORM_BASE_URL = 'http://localhost:4000';
const GITHUB_CALLBACK_PATH = /\/api\/v1\/auth\/github\/callback\/?$/;
const API_V1_PATH = /\/api\/v1\/?$/;
const WORKFLOW_DIRECTORY = '.github/workflows';

function normalizePlatformBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(API_V1_PATH, '');
}

export function resolvePlatformBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit =
    env['PLATFORM_PUBLIC_URL']?.trim() || env['API_PUBLIC_URL']?.trim();

  if (explicit) {
    return normalizePlatformBaseUrl(explicit);
  }

  const callbackUrl = env['GITHUB_CALLBACK_URL']?.trim();
  if (callbackUrl) {
    return normalizePlatformBaseUrl(
      callbackUrl.replace(GITHUB_CALLBACK_PATH, ''),
    );
  }

  return DEFAULT_LOCAL_PLATFORM_BASE_URL;
}

/**
 * Where a workflow names the API: the text before `/api/v1/ci` in any URL
 * (`ALPHACI_VALIDATE_URL`, the release and report calls), without matching
 * a longer path such as `/api/v1/ci-legacy`.
 */
const BASE_BEFORE_CI_PATH =
  /https?:\/\/[^\s'"`<>]*?(?=\/api\/v1\/ci(?![\w-]))/g;

/** The `alphaci-api-url:` input of the reusable workflow call, one value per line. */
const API_URL_INPUT =
  /^(\s*['"]?alphaci-api-url['"]?\s*:\s*['"]?)(https?:\/\/[^\s'"#]*?)\/?(?=['"]?\s*(?:#.*)?$)/gm;

function withoutTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export interface CiApiBaseRewrite {
  /** The file with every stale base replaced. Equal to the input when none was stale. */
  content: string;
  /** Each base the file named that is not the expected one, once, as written. */
  staleBases: string[];
}

/**
 * Point every AlphaCI API base in one workflow file at `expectedBase`.
 *
 * Only the API bases are touched. Other URLs (GitHub's own, action sources,
 * anything else a workflow quotes) stay exactly as written.
 */
export function rewriteCiApiBase(
  content: string,
  expectedBase: string,
): CiApiBaseRewrite {
  const expected = withoutTrailingSlashes(expectedBase.trim());
  const expectedKey = expected.toLowerCase();
  const stale = new Set<string>();

  const swap = (found: string): string => {
    const base = withoutTrailingSlashes(found);
    if (base.toLowerCase() === expectedKey) {
      return found;
    }
    stale.add(base);
    return expected;
  };

  const rewritten = content
    .replace(BASE_BEFORE_CI_PATH, (found) => swap(found))
    .replace(
      API_URL_INPUT,
      (_match, prefix: string, found: string) => prefix + swap(found),
    );

  return { content: rewritten, staleBases: [...stale] };
}

export interface StaleCiWorkflowFile {
  path: string;
  /** The file as it reads once every stale base is replaced. */
  content: string;
  staleBases: string[];
}

/**
 * The committed workflow files on one branch that name an AlphaCI API other
 * than `expectedBase`.
 *
 * A branch that does not exist reads as no files. A read GitHub refuses
 * throws: the caller decides whether "unknown" means "nothing to report" or
 * "stop", and this never guesses.
 */
export async function findStaleCiWorkflowFiles(
  github: Pick<GithubProjectPort, 'listRepoContents' | 'getFileContent'>,
  accessToken: string,
  repoFullName: string,
  branch: string,
  expectedBase: string,
): Promise<StaleCiWorkflowFile[]> {
  const [owner, repo] = repoFullName.split('/');
  if (!owner || !repo) {
    return [];
  }

  const listing = await github.listRepoContents(
    accessToken,
    repoFullName,
    WORKFLOW_DIRECTORY,
    branch,
  );
  const stale: StaleCiWorkflowFile[] = [];
  for (const entry of listing.entries) {
    if (!isWorkflowFile(entry)) {
      continue;
    }
    const content = await github.getFileContent(
      accessToken,
      owner,
      repo,
      entry.path,
      branch,
    );
    if (content === null) {
      continue;
    }
    const rewrite = rewriteCiApiBase(content, expectedBase);
    if (rewrite.staleBases.length > 0) {
      stale.push({
        path: entry.path,
        content: rewrite.content,
        staleBases: rewrite.staleBases,
      });
    }
  }
  return stale;
}

function isWorkflowFile(entry: GitHubContentEntry): boolean {
  return entry.type === 'file' && /\.ya?ml$/i.test(entry.name);
}
