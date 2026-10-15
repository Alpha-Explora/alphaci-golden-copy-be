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
const TEN_MINUTES = 10 * 60_000;
const ONE_DAY = 24 * 60 * 60_000;

interface ServedRelease {
  bytes?: Buffer;
  metadata?: Record<string, unknown>;
  assetUrl?: string;
  immutable?: boolean;
}

/** Serves one published release through fetch, as the GitHub API and downloads do. */
function serveRelease(overrides: ServedRelease = {}) {
  const routes = new Map<string, () => Response>([
    [
      tagUrl,
      () =>
        Response.json({
          immutable: overrides.immutable ?? true,
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
const headersOf = (call: unknown[] | undefined): Record<string, string> =>
  (call?.[1] as { headers?: Record<string, string> } | undefined)?.headers ??
  {};

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('returns the archive only after its bytes match the published hash', async () => {
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  await expect(client.resolve({ repo, version: '0.1.0' })).resolves.toEqual(
    verified,
  );
  expect(requestedUrls(fetch)).toEqual([tagUrl, metadataUrl, archiveUrl]);
});
it('caches a verified release for ten minutes', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  await client.resolve(lookup);
  expect(fetch).toHaveBeenCalledTimes(3);
  now.mockReturnValue(1_000 + TEN_MINUTES - 1);
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
  expect(fetch).toHaveBeenCalledTimes(3);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
  expect(fetch).toHaveBeenCalledTimes(6);
});
it('shares one in-flight lookup between concurrent callers', async () => {
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await expect(
    Promise.all([client.resolve(lookup), client.resolve(lookup)]),
  ).resolves.toEqual([verified, verified]);
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('does not cache a failed lookup', async () => {
  const fetch = serveRelease();
  fetch.mockResolvedValueOnce(new Response('busy', { status: 503 }));
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await expect(client.resolve(lookup)).resolves.toBeUndefined();
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('refuses a release that GitHub does not mark immutable when no hash is pinned', async () => {
  const fetch = serveRelease({ immutable: false });
  const client = new OnpremInstallerReleaseClient();
  await expect(
    client.resolve({ repo, version: '0.1.0' }),
  ).resolves.toBeUndefined();
  expect(requestedUrls(fetch)).toEqual([tagUrl]);
});
it('verifies a pinned hash from the predictable download URL without the API', async () => {
  const fetch = serveRelease({ immutable: false });
  const client = new OnpremInstallerReleaseClient();
  await expect(
    client.resolve({ repo, version: '0.1.0', pinnedSha256: sha256 }),
  ).resolves.toEqual(verified);
  expect(requestedUrls(fetch)).toEqual([archiveUrl]);
});
it('refuses an archive that does not match a pinned hash', async () => {
  serveRelease({ bytes: Buffer.from('tampered') });
  const client = new OnpremInstallerReleaseClient();
  await expect(
    client.resolve({ repo, version: '0.1.0', pinnedSha256: sha256 }),
  ).resolves.toBeUndefined();
});
it('refuses an archive whose bytes do not match the published hash', async () => {
  serveRelease({ bytes: Buffer.from('tampered') });
  const client = new OnpremInstallerReleaseClient();
  await expect(
    client.resolve({ repo, version: '0.1.0' }),
  ).resolves.toBeUndefined();
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
  await expect(
    client.resolve({ repo, version: '0.1.0' }),
  ).resolves.toBeUndefined();
});
it('refuses an archive URL outside the repository release, without requesting it', async () => {
  const fetch = serveRelease({
    assetUrl: 'https://evil.example/alphaci-agent-0.1.0.tar.gz',
  });
  const client = new OnpremInstallerReleaseClient();
  await expect(
    client.resolve({ repo, version: '0.1.0' }),
  ).resolves.toBeUndefined();
  expect(requestedUrls(fetch)).toEqual([tagUrl, metadataUrl]);
});
it('sends the API token to the release API only', async () => {
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  await client.resolve({ repo, version: '0.1.0', token: 'release-token' });
  const calls = fetch.mock.calls;
  expect(headersOf(calls[0])).toMatchObject({
    Authorization: 'Bearer release-token',
  });
  expect(headersOf(calls[1])).not.toHaveProperty('Authorization');
  expect(headersOf(calls[2])).not.toHaveProperty('Authorization');
});
it('serves the last verified archive when the API is rate limited', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  fetch.mockResolvedValueOnce(new Response('limited', { status: 429 }));
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
});
it('serves the last verified archive for a transient server error', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  fetch.mockResolvedValueOnce(new Response('down', { status: 503 }));
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
});
it('does not serve a stale archive after a permanent failure', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  fetch.mockResolvedValueOnce(new Response('gone', { status: 404 }));
  await expect(client.resolve(lookup)).resolves.toBeUndefined();
});
it('stops serving the last verified archive after a day', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + ONE_DAY);
  fetch.mockResolvedValueOnce(new Response('down', { status: 503 }));
  await expect(client.resolve(lookup)).resolves.toBeUndefined();
});
const tagBody = () => ({
  immutable: true,
  assets: [
    { name: 'installer-release.json', browser_download_url: metadataUrl },
    { name: 'alphaci-agent-0.1.0.tar.gz', browser_download_url: archiveUrl },
  ],
});
const metadataBody = () => ({
  version: '0.1.0',
  file: 'alphaci-agent-0.1.0.tar.gz',
  sha256,
});
/** A response whose body breaks mid-transfer, as a reset connection does. */
const brokenResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    }),
  );
it('treats a release body that breaks mid-transfer as transient', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  fetch.mockResolvedValueOnce(brokenResponse());
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
});
it('treats an archive body that breaks mid-transfer as transient', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  fetch
    .mockResolvedValueOnce(Response.json(tagBody()))
    .mockResolvedValueOnce(Response.json(metadataBody()))
    .mockResolvedValueOnce(brokenResponse());
  await expect(client.resolve(lookup)).resolves.toEqual(verified);
});
it('clears the verified archive on a permanent failure, so a later transient failure issues no code', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const fetch = serveRelease();
  const client = new OnpremInstallerReleaseClient();
  const lookup = { repo, version: '0.1.0' };
  await client.resolve(lookup);
  now.mockReturnValue(1_000 + TEN_MINUTES);
  fetch.mockResolvedValueOnce(new Response('gone', { status: 404 }));
  await expect(client.resolve(lookup)).resolves.toBeUndefined();
  now.mockReturnValue(1_000 + TEN_MINUTES + 1);
  fetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
  await expect(client.resolve(lookup)).resolves.toBeUndefined();
});
it('rejects a malformed repository, version, or pin without any request', async () => {
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 500 }));
  const client = new OnpremInstallerReleaseClient();
  await expect(
    client.resolve({ repo: 'not a repo', version: '0.1.0' }),
  ).resolves.toBeUndefined();
  await expect(
    client.resolve({ repo, version: '0.1' }),
  ).resolves.toBeUndefined();
  await expect(
    client.resolve({ repo, version: '0.1.0', pinnedSha256: 'not-a-hash' }),
  ).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
