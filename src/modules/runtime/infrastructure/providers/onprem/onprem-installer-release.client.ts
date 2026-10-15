import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { InstallerRelease } from '../../../application/onprem/onprem-host.contracts';
import type {
  OnpremInstallerReleaseLookup,
  OnpremInstallerReleasePort,
} from '../../../application/ports/onprem-installer-release.port';

const GITHUB_URL = 'https://github.com';
const GITHUB_API_URL = 'https://api.github.com';
const FRESH_TTL_MS = 10 * 60_000;
const STALE_TTL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const RELEASE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INSTALLER_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Tag that carries one installer version, for example `onprem-agent-v0.1.0`. */
export const onpremInstallerTag = (version: string): string =>
  `onprem-agent-v${version}`;

/** Archive name written by `scripts/package-onprem-agent.mjs`. */
export const onpremInstallerArchiveName = (version: string): string =>
  `alphaci-agent-${version}.tar.gz`;

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

/** A failure that may pass on its own (rate limit, server error, network). */
class TransientReleaseError extends Error {}

interface VerifiedEntry {
  release: InstallerRelease;
  verifiedAt: number;
}

/**
 * Resolves the installer archive for one version. A result is returned only
 * after the downloaded bytes match a SHA-256: the operator's pin when one is
 * configured, otherwise the hash in the release's installer-release.json, and
 * then only for a release GitHub marks immutable. Any other failure resolves
 * to undefined, so the caller refuses to issue an enrollment code. A transient
 * failure serves the last verified result for up to a day.
 */
@Injectable()
export class OnpremInstallerReleaseClient implements OnpremInstallerReleasePort {
  private readonly logger = new Logger(OnpremInstallerReleaseClient.name);
  private readonly verified = new Map<string, VerifiedEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<InstallerRelease | undefined>
  >();

  async resolve(
    lookup: OnpremInstallerReleaseLookup,
  ): Promise<InstallerRelease | undefined> {
    const key = `${lookup.repo}@${lookup.version}#${lookup.pinnedSha256 ?? ''}`;
    const entry = this.verified.get(key);
    if (entry && Date.now() - entry.verifiedAt < FRESH_TTL_MS)
      return entry.release;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const attempt = this.refresh(key, lookup);
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private refresh(
    key: string,
    lookup: OnpremInstallerReleaseLookup,
  ): Promise<InstallerRelease | undefined> {
    return this.fetchVerified(lookup)
      .then(
        (release) => {
          this.verified.set(key, { release, verifiedAt: Date.now() });
          return release;
        },
        (error: unknown) => this.fallBack(key, lookup, error),
      )
      .finally(() => {
        this.inFlight.delete(key);
      });
  }

  private fallBack(
    key: string,
    lookup: OnpremInstallerReleaseLookup,
    error: unknown,
  ): InstallerRelease | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const entry = this.verified.get(key);
    if (
      error instanceof TransientReleaseError &&
      entry &&
      Date.now() - entry.verifiedAt < STALE_TTL_MS
    ) {
      this.logger.warn(
        `Installer ${lookup.version} from ${lookup.repo} is temporarily unavailable (${message}); serving the last verified archive.`,
      );
      return entry.release;
    }
    this.logger.warn(
      `Installer ${lookup.version} from ${lookup.repo} could not be verified: ${message}`,
    );
    return undefined;
  }

  private async fetchVerified({
    repo,
    version,
    pinnedSha256,
    token,
  }: OnpremInstallerReleaseLookup): Promise<InstallerRelease> {
    if (!RELEASE_REPO.test(repo))
      throw new Error('ONPREM_INSTALLER_RELEASE_REPO must be owner/repo.');
    if (!INSTALLER_VERSION.test(version))
      throw new Error('ONPREM_INSTALLER_VERSION must be x.y.z.');
    const tag = onpremInstallerTag(version);
    const archive = onpremInstallerArchiveName(version);
    if (pinnedSha256) {
      // The pin comes from configuration, so release metadata is not needed
      // and the GitHub API is not called.
      if (!SHA256_HEX.test(pinnedSha256))
        throw new Error('ONPREM_INSTALLER_SHA256 must be 64 lowercase hex.');
      const url = `${GITHUB_URL}/${repo}/releases/download/${tag}/${archive}`;
      await this.assertArchiveHash(url, pinnedSha256);
      return { version, url, sha256: pinnedSha256 };
    }
    const release = await this.getJson<{
      immutable?: unknown;
      assets?: ReleaseAsset[];
    }>(
      `${GITHUB_API_URL}/repos/${repo}/releases/tags/${tag}`,
      'application/vnd.github+json',
      token,
    );
    // Without a pin, the hash comes from the same release as the archive. Only
    // an immutable release guarantees that the pair was not replaced later.
    if (release.immutable !== true)
      throw new Error(
        'The release is not immutable. Enable immutable releases or pin ONPREM_INSTALLER_SHA256.',
      );
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const metadata = await this.getJson<{
      version?: unknown;
      file?: unknown;
      sha256?: unknown;
    }>(
      assetUrl(assets, 'installer-release.json', repo, tag),
      'application/json',
    );
    if (
      metadata.version !== version ||
      metadata.file !== archive ||
      typeof metadata.sha256 !== 'string' ||
      !SHA256_HEX.test(metadata.sha256)
    )
      throw new Error('installer-release.json does not describe this version.');
    const url = assetUrl(assets, archive, repo, tag);
    await this.assertArchiveHash(url, metadata.sha256);
    return { version, url, sha256: metadata.sha256 };
  }

  private async assertArchiveHash(
    url: string,
    expected: string,
  ): Promise<void> {
    const bytes = await this.getBytes(url);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected)
      throw new Error('Installer archive does not match its expected SHA-256.');
  }

  private async getJson<T>(
    url: string,
    accept: string,
    token?: string,
  ): Promise<T> {
    const response = await this.get(url, accept, token);
    return (await response.json()) as T;
  }

  private async getBytes(url: string): Promise<Buffer> {
    const response = await this.get(url, 'application/octet-stream');
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_ARCHIVE_BYTES)
      throw new Error('Installer archive exceeds the size limit.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ARCHIVE_BYTES)
      throw new Error('Installer archive exceeds the size limit.');
    return bytes;
  }

  /** The token, when given, goes to the API only and is never logged. */
  private async get(
    url: string,
    accept: string,
    token?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': 'alphaci-onprem-installer',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TransientReleaseError(
        `Release request failed: ${error instanceof Error ? error.message : 'network error'}.`,
      );
    }
    if (response.ok) return response;
    const message = `Release request returned HTTP ${response.status}.`;
    const transient =
      response.status === 403 ||
      response.status === 429 ||
      response.status >= 500;
    throw transient ? new TransientReleaseError(message) : new Error(message);
  }
}

/** Only GitHub download URLs under this exact release tag are accepted. */
function assetUrl(
  assets: ReleaseAsset[],
  name: string,
  repo: string,
  tag: string,
): string {
  const download = assets.find(
    (asset) => asset.name === name,
  )?.browser_download_url;
  if (typeof download !== 'string')
    throw new Error(`Release asset ${name} is missing.`);
  const url = new URL(download);
  const prefix = `/${repo}/releases/download/${tag}/`.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(prefix)
  )
    throw new Error(`Release asset ${name} is not served by ${repo}.`);
  return url.toString();
}
