import {
  resolveReleaseSigningSource,
  RELEASE_SIGNING_KMS_KEY_VERSION_ENV,
  RELEASE_SIGNING_LAB_KEY_PATH_ENV,
} from './release-signing.config';

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';

function sourceFrom(env: Record<string, string | undefined>) {
  return resolveReleaseSigningSource((key) => env[key]);
}

describe('resolveReleaseSigningSource', () => {
  it('uses the Cloud KMS key version when it is a full key-version name', () => {
    expect(
      sourceFrom({ [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION }),
    ).toEqual({ kind: 'kms', keyVersion: KEY_VERSION });
  });

  it('trims surrounding whitespace from the key version', () => {
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: `  ${KEY_VERSION}\n`,
      }),
    ).toEqual({ kind: 'kms', keyVersion: KEY_VERSION });
  });

  it('uses the lab key path only when Cloud KMS is not configured', () => {
    expect(
      sourceFrom({ [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: ' /run/keys/lab.pem ' }),
    ).toEqual({ kind: 'lab', keyPath: '/run/keys/lab.pem' });
  });

  it('prefers Cloud KMS over the lab key when both are configured', () => {
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION,
        [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '/run/keys/lab.pem',
      }),
    ).toEqual({ kind: 'kms', keyVersion: KEY_VERSION });
  });

  it.each([
    { name: 'neither is set', env: {} },
    {
      name: 'both are blank',
      env: {
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: '   ',
        [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '',
      },
    },
  ])('reports no signing source when $name', ({ env }) => {
    expect(sourceFrom(env)).toEqual({ kind: 'none' });
  });

  it.each([
    'projects/p/locations/l/keyRings/r/cryptoKeys/k',
    'release-signing',
    'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/',
    `${KEY_VERSION}/extra`,
    'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1 2',
  ])(
    'treats %s as an invalid KMS key version, without falling back to the lab key',
    (value) => {
      expect(
        sourceFrom({
          [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: value,
          [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '/run/keys/lab.pem',
        }),
      ).toEqual({ kind: 'invalid-kms' });
    },
  );
});
