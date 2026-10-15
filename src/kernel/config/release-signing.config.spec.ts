import {
  releaseSignerFor,
  resolveReleaseSigningSource,
  RELEASE_SIGNER_SERVICE_ACCOUNT_ENV,
  RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV,
  RELEASE_SIGNING_KMS_KEY_VERSION_ENV,
  RELEASE_SIGNING_LAB_KEY_PATH_ENV,
} from './release-signing.config';

const KEY_VERSION =
  'projects/alphaci-prod/locations/europe-west1/keyRings/release/cryptoKeys/release-signing/cryptoKeyVersions/3';
const SIGNER = {
  workloadIdentityProvider:
    'projects/123456789/locations/global/workloadIdentityPools/alphaci-release/providers/github',
  serviceAccount: 'release-signer@alphaci-prod.iam.gserviceaccount.com',
};
const COMPLETE_SIGNER_ENV = {
  [RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV]:
    SIGNER.workloadIdentityProvider,
  [RELEASE_SIGNER_SERVICE_ACCOUNT_ENV]: SIGNER.serviceAccount,
};

function sourceFrom(env: Record<string, string | undefined>) {
  return resolveReleaseSigningSource((key) => env[key]);
}

describe('resolveReleaseSigningSource', () => {
  it('uses Cloud KMS when the key version and the complete signer are set', () => {
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION,
        ...COMPLETE_SIGNER_ENV,
      }),
    ).toEqual({ kind: 'kms', keyVersion: KEY_VERSION, signer: SIGNER });
  });

  it('trims surrounding whitespace from every value', () => {
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: `  ${KEY_VERSION}\n`,
        [RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV]: ` ${SIGNER.workloadIdentityProvider} `,
        [RELEASE_SIGNER_SERVICE_ACCOUNT_ENV]: `${SIGNER.serviceAccount}\t`,
      }),
    ).toEqual({ kind: 'kms', keyVersion: KEY_VERSION, signer: SIGNER });
  });

  it('uses the lab key path only when Cloud KMS is not configured at all', () => {
    expect(
      sourceFrom({
        [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: ' /run/keys/lab.pem ',
      }),
    ).toEqual({ kind: 'lab', keyPath: '/run/keys/lab.pem' });
  });

  it('reports no source when nothing is set or every value is blank', () => {
    expect(sourceFrom({})).toEqual({ kind: 'none' });
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: '   ',
        [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '',
      }),
    ).toEqual({ kind: 'none' });
  });

  it.each([
    {
      name: 'neither signer setting',
      env: {},
      missing: [
        RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV,
        RELEASE_SIGNER_SERVICE_ACCOUNT_ENV,
      ],
    },
    {
      name: 'only the provider',
      env: {
        [RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV]:
          SIGNER.workloadIdentityProvider,
      },
      missing: [RELEASE_SIGNER_SERVICE_ACCOUNT_ENV],
    },
    {
      name: 'only the service account',
      env: { [RELEASE_SIGNER_SERVICE_ACCOUNT_ENV]: SIGNER.serviceAccount },
      missing: [RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV],
    },
  ])(
    'is invalid, and never a lab fallback, when the signer is incomplete ($name)',
    ({ env, missing }) => {
      const source = sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION,
        [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '/run/keys/lab.pem',
        ...env,
      });

      expect(source.kind).toBe('invalid');
      if (source.kind === 'invalid') {
        for (const name of missing) expect(source.problem).toContain(name);
      }
    },
  );

  it('rejects a malformed signer provider and service account', () => {
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION,
        [RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV]: 'github-pool/provider',
        [RELEASE_SIGNER_SERVICE_ACCOUNT_ENV]: SIGNER.serviceAccount,
      }),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION,
        [RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER_ENV]:
          SIGNER.workloadIdentityProvider,
        [RELEASE_SIGNER_SERVICE_ACCOUNT_ENV]: 'release-signer@example.com',
      }),
    ).toMatchObject({ kind: 'invalid' });
  });

  it.each(['latest', 'v3', '1 2', '3/extra'])(
    'rejects a key version ending in %p, without a lab fallback',
    (version) => {
      const source = sourceFrom({
        [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION.replace(
          /3$/,
          version,
        ),
        [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '/run/keys/lab.pem',
        ...COMPLETE_SIGNER_ENV,
      });

      expect(source.kind).toBe('invalid');
    },
  );

  it('requires the key version to end in digits, as the sign-release workflow does', () => {
    const versionPath = (tail: string) =>
      'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/' +
      tail;
    for (const tail of ['1', '42']) {
      expect(
        sourceFrom({
          [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: versionPath(tail),
          ...COMPLETE_SIGNER_ENV,
        }),
      ).toMatchObject({ kind: 'kms' });
    }
    for (const tail of ['latest', 'v3', '']) {
      expect(
        sourceFrom({
          [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: versionPath(tail),
          ...COMPLETE_SIGNER_ENV,
        }),
      ).toMatchObject({ kind: 'invalid' });
    }
  });
});

describe('releaseSignerFor', () => {
  it('returns the signer only when Cloud KMS is fully configured', () => {
    expect(
      releaseSignerFor(
        (key) =>
          ({
            [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION,
            ...COMPLETE_SIGNER_ENV,
          })[key],
      ),
    ).toEqual(SIGNER);
  });

  it('is undefined for the lab key and for an incomplete signer', () => {
    expect(
      releaseSignerFor(
        (key) =>
          ({ [RELEASE_SIGNING_LAB_KEY_PATH_ENV]: '/run/keys/lab.pem' })[key],
      ),
    ).toBeUndefined();
    expect(
      releaseSignerFor(
        (key) => ({ [RELEASE_SIGNING_KMS_KEY_VERSION_ENV]: KEY_VERSION })[key],
      ),
    ).toBeUndefined();
  });
});
