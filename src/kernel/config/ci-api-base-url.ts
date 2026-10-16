import type {
  GitHubContentEntry,
  GithubProjectPort,
} from '#kernel/ports/github.port';
import { validateCiApiConnectivity } from './ci-api-connectivity';

/**
 * The public AlphaCI API base that generated workflows and repository secrets
 * point at, and the scan that finds committed workflows still naming another.
 *
 * Kept in the kernel because two halves of the product agree on it: the
 * workflow generator writes the base into `.github/workflows`, and drift
 * detection and repair read it back out of committed files.
 *
 * `resolvePlatformBaseUrl` reads the environment on every call. The workflow
 * builder captures its own copy once, at import, so drift and repair call this
 * function themselves rather than reusing the builder's constants.
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
 * Whether GitHub-hosted runners can reach this base. Localhost, loopback,
 * private and non-HTTPS addresses cannot be reached from them, so a repair
 * toward one would only swap a broken address for another. Uses the same rule
 * the generated preflight enforces, so the two cannot disagree.
 */
export function isReachableFromGithubRunners(base: string): boolean {
  try {
    validateCiApiConnectivity(base, 'github-hosted');
    return true;
  } catch {
    return false;
  }
}

/** One `scheme://host[:port]` as written: no path, quote, comma or expression. */
const ORIGIN = /https?:\/\/[A-Za-z0-9._:[\]-]+/g;
/** The AlphaCI API paths, straight after an origin. */
const API_PATH_AFTER = /^\/api\/v1\/ci(?![\w-])/;
/**
 * The start of a value under a key AlphaCI writes: `ALPHACI_*_URL`, or any
 * `*api-url` (the reusable workflow's `alphaci-api-url` input, `api-url`).
 */
const KEYED_VALUE_START =
  /^\s*['"]?(?:ALPHACI_[A-Z0-9_]*_URL|[A-Za-z0-9_-]*api-url)['"]?\s*:\s*['"]?/;
/** A whole-line YAML comment carries no config: never flagged, never rewritten. */
const COMMENT_LINE = /^\s*#/;

/**
 * A base as the comparison sees it: scheme and host lower-cased, default port
 * dropped (`https://h:443` is `https://h`), no trailing slash.
 */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

interface Origin {
  text: string;
  start: number;
  end: number;
}

function originsIn(line: string): Origin[] {
  return [...line.matchAll(ORIGIN)].map((match) => {
    const start = match.index ?? 0;
    return { text: match[0], start, end: start + match[0].length };
  });
}

/**
 * The origins on a line that AlphaCI uses as its API: the value under a key
 * AlphaCI writes, or an origin that sits before `/api/v1/ci`. A host that
 * appears anywhere else (GitHub, an action source) is not one of them.
 */
function apiOriginsIn(line: string): Origin[] {
  const keyed = KEYED_VALUE_START.exec(line);
  const valueStart = keyed ? keyed[0].length : -1;
  return originsIn(line).filter(
    (origin) =>
      origin.start === valueStart ||
      API_PATH_AFTER.test(line.slice(origin.end)),
  );
}

export interface CiApiBaseRewrite {
  /** The file with every stale base replaced. Equal to the input when none was stale. */
  content: string;
  /** Each base the file uses as its API that is not the expected one, once, as written. */
  staleBases: string[];
}

/**
 * Point every stale AlphaCI API base in one workflow file at `expectedBase`.
 *
 * A base is stale when the file uses it as its API (see `apiOriginsIn`). Once
 * a base is stale, every occurrence of it in the file is replaced, so a bare
 * `ALPHACI_API_URL: <base>` in a job's env and a `<base>/api/v1/ci` URL are
 * fixed together. Whole-line comments are left alone, `${{ }}` expressions are
 * never treated as a literal base, and any other URL stays exactly as written.
 */
export function rewriteCiApiBase(
  content: string,
  expectedBase: string,
): CiApiBaseRewrite {
  const expected = expectedBase.trim().replace(/\/+$/, '');
  const expectedKey = normalizeOrigin(expected);
  const lines = content.split('\n');

  const stale = new Map<string, string>();
  for (const line of lines) {
    if (COMMENT_LINE.test(line)) continue;
    for (const origin of apiOriginsIn(line)) {
      const key = normalizeOrigin(origin.text);
      if (key !== expectedKey && !stale.has(key)) {
        stale.set(key, origin.text);
      }
    }
  }
  if (stale.size === 0) {
    return { content, staleBases: [] };
  }

  const rewritten = lines.map((line) => {
    if (COMMENT_LINE.test(line)) return line;
    return line.replace(ORIGIN, (text: string, offset: number) => {
      // `https://host${{ ... }}` is an expression, not a base to replace.
      const next = line.charAt(offset + text.length);
      if (next === '$' || next === '{') return text;
      return stale.has(normalizeOrigin(text)) ? expected : text;
    });
  });

  return { content: rewritten.join('\n'), staleBases: [...stale.values()] };
}

export interface StaleCiWorkflowFile {
  path: string;
  /** The file as it reads once every stale base is replaced. */
  content: string;
  staleBases: string[];
}

/**
 * The committed workflow files at `ref` (a branch name or a commit SHA) that
 * name an AlphaCI API other than `expectedBase`.
 *
 * A ref that does not exist reads as no files. A read GitHub refuses throws:
 * the caller decides whether "unknown" means "nothing to report" or "stop", and
 * this never guesses.
 */
export async function findStaleCiWorkflowFiles(
  github: Pick<GithubProjectPort, 'listRepoContents' | 'getFileContent'>,
  accessToken: string,
  repoFullName: string,
  ref: string,
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
    ref,
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
      ref,
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
