import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { InstallerRelease } from '../../../application/onprem/onprem-host.contracts';
import type { OnpremInstallerReleasePort } from '../../../application/ports/onprem-installer-release.port';

const GITHUB_API_URL = 'https://api.github.com';
const CACHE_TTL_MS = 10 * 60_000;
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

/**
 * Resolves the installer archive published as a GitHub release asset. A result
 * is returned only after the downloaded bytes match the SHA-256 in that
 * release's installer-release.json. Any failure resolves to undefined, so the
 * caller can refuse to issue an enrollment code.
 */
@Injectable()
export class OnpremInstallerReleaseClient implements OnpremInstallerReleasePort {
  private readonly logger = new Logger(OnpremInstallerReleaseClient.name);
  private readonly cache = new Map<
    string,
    { release: InstallerRelease; expiresAt: number }
  >();

  async resolve(
    repo: string,
    version: string,
  ): Promise<InstallerRelease | undefined> {
    const key = `${repo}@${version}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.release;
    try {
      const release = await this.fetchVerified(repo, version);
      this.cache.set(key, { release, expiresAt: Date.now() + CACHE_TTL_MS });
      return release;
    } catch (error) {
      this.logger.warn(
        `Installer ${version} from ${repo} could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private async fetchVerified(
    repo: string,
    version: string,
  ): Promise<InstallerRelease> {
    if (!RELEASE_REPO.test(repo))
      throw new Error('ONPREM_INSTALLER_RELEASE_REPO must be owner/repo.');
    if (!INSTALLER_VERSION.test(version))
      throw new Error('ONPREM_INSTALLER_VERSION must be x.y.z.');
    const tag = onpremInstallerTag(version);
    const archive = onpremInstallerArchiveName(version);
    const release = await this.getJson<{ assets?: ReleaseAsset[] }>(
      `${GITHUB_API_URL}/repos/${repo}/releases/tags/${tag}`,
      'application/vnd.github+json',
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
    const bytes = await this.getBytes(url);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== metadata.sha256)
      throw new Error(
        'Installer archive does not match installer-release.json.',
      );
    return { version, url, sha256 };
  }

  private async getJson<T>(url: string, accept: string): Promise<T> {
    const response = await this.get(url, accept);
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

  private async get(url: string, accept: string): Promise<Response> {
    const response = await fetch(url, {
      headers: { Accept: accept, 'User-Agent': 'alphaci-onprem-installer' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Release request returned HTTP ${response.status}.`);
    return response;
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
