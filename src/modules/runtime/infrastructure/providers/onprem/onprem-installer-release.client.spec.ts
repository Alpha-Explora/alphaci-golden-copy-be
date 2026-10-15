import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { OnpremInstallerReleaseClient } from './onprem-installer-release.client';

const repo = 'Alpha-Explora/alphaci';
const archive = Buffer.from('installer archive bytes');
const sha256 = createHash('sha256').update(archive).digest('hex');
const tagUrl = `https://api.github.com/repos/${repo}/releases/tags/onprem-agent-v0.1.0`;
const downloadBase = `https://github.com/${repo}/releases/download/onprem-agent-v0.1.0`;
const metadataUrl = `${downloadBase}/installer-release.json`;
const archiveUrl = `${downloadBase}/alphaci-agent-0.1.0.tar.gz`;
const verified = { version: '0.1.0', url: archiveUrl, sha256 };

/** Serves one published release through fetch, as the GitHub API and downloads do. */
function serveRelease(
  overrides: {
    bytes?: Buffer;
    metadata?: Record<string, unknown>;
    assetUrl?: string;
  } = {},
) {
  const routes = new Map<string, () => Response>([
    [
      tagUrl,
      () =>
        Response.json({
          assets: [
            {
              name: 'installer-release.json',
              browser_download_url: metadataUrl,
            },
            {
              name: 'alphaci-agent-0.1.0.tar.gz',
              browser_download_url: overrides.assetUrl ?? archiveUrl,
            },
          ],
        }),
    ],
    [
      metadataUrl,
      () =>
        Response.json(
          overrides.metadata ?? {
            version: '0.1.0',
            file: 'alphaci-agent-0.1.0.tar.gz',
            sha256,
          },
        ),
    ],
    [
      archiveUrl,
      () => new Response(new Uint8Array(overrides.bytes ?? archive)),
    ],
  ]);
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const route = routes.get(String(input));
    return route ? route() : new Response('not found', { status: 404 });
  });
}
const requestedUrls = (fetch: jest.SpyInstance) =>
  fetch.mock.calls.map(([input]) => String(input));

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('returns the archive only after its bytes match the published hash', async () => {
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve(repo, '0.1.0')).resolves.toEqual(verified);
  expect(requestedUrls(fetch)).toEqual([tagUrl, metadataUrl, archiveUrl]);
});
it('caches a verified release for ten minutes', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  await client.resolve(repo, '0.1.0');
  await client.resolve(repo, '0.1.0');
  expect(fetch).toHaveBeenCalledTimes(3);
  now.mockReturnValue(1_000 + 10 * 60_000 - 1);
  await expect(client.resolve(repo, '0.1.0')).resolves.toEqual(verified);
  expect(fetch).toHaveBeenCalledTimes(3);
  now.mockReturnValue(1_000 + 10 * 60_000);
  await expect(client.resolve(repo, '0.1.0')).resolves.toEqual(verified);
  expect(fetch).toHaveBeenCalledTimes(6);
});
it('does not cache a failed lookup', async () => {
  const fetch = serveRelease();
  fetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve(repo, '0.1.0')).resolves.toBeUndefined();
  await expect(client.resolve(repo, '0.1.0')).resolves.toEqual(verified);
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('refuses an archive whose bytes do not match the published hash', async () => {
  serveRelease({ bytes: Buffer.from('tampered') });
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve(repo, '0.1.0')).resolves.toBeUndefined();
});
it('refuses metadata that describes another version', async () => {
  serveRelease({
    metadata: {
      version: '0.2.0',
      file: 'alphaci-agent-0.1.0.tar.gz',
      sha256,
    },
  });
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve(repo, '0.1.0')).resolves.toBeUndefined();
});
it('refuses an archive URL outside the repository release, without requesting it', async () => {
  const fetch = serveRelease({
    assetUrl: 'https://evil.example/alphaci-agent-0.1.0.tar.gz',
  });
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve(repo, '0.1.0')).resolves.toBeUndefined();
  expect(requestedUrls(fetch)).toEqual([tagUrl, metadataUrl]);
});
it('rejects a malformed repository or version without any request', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 500 }));
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve('not a repo', '0.1.0')).resolves.toBeUndefined();
  await expect(client.resolve(repo, '0.1')).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
