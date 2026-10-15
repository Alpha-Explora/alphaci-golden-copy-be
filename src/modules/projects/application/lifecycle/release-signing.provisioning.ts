import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Logger } from '@nestjs/common';

import {
  RELEASE_SIGNING_LAB_KEY_PATH_ENV,
  resolveReleaseSigningSource,
} from '#kernel/config/release-signing.config';
import type { DeploymentProvisioningRequestDto } from '../../api/dto/create-project.dto';
import type { ProjectProvisioningSupport } from './project-provisioning.support';

/** Repository variable the release-signing job reads for Cloud KMS signing. */
export const RELEASE_SIGNING_VARIABLE = 'ALPHACI_RELEASE_KMS_KEY_VERSION';
/** Repository secret the release-signing job reads for the lab key (lab only). */
export const RELEASE_SIGNING_SECRET = 'ALPHACI_RELEASE_SIGNING_KEY';

const logger = new Logger('ReleaseSigningProvisioning');

const NOT_CONFIGURED_WARNING =
  'Releases cannot be signed yet: AlphaCI has no release signing configured. Set ALPHACI_RELEASE_KMS_KEY_VERSION on the AlphaCI backend, then add the repository variable ALPHACI_RELEASE_KMS_KEY_VERSION with the same value.';

const INVALID_KMS_WARNING =
  'Releases cannot be signed: ALPHACI_RELEASE_KMS_KEY_VERSION on the AlphaCI backend is not a full Cloud KMS key version name (projects/.../cryptoKeyVersions/N). Correct it, then add the repository variable with the same value.';

/**
 * Configures how this repository's release-signing job gets its key. Runs next
 * to the ALPHACI_* secrets, for requests that include a host-delivered target
 * (the on-prem Compose provider today): an on-prem host only runs releases that
 * carry a signature it can verify.
 *
 * Returns a warning for the create response when releases from the repository
 * cannot be signed. It never throws: a signing gap must not roll back a
 * repository that is otherwise usable, and the warning tells the caller what
 * to fix. Key material is never logged or returned.
 */
export async function configureReleaseSigning(
  support: Pick<
    ProjectProvisioningSupport,
    'githubService' | 'configService' | 'workflowFragmentRegistry'
  >,
  input: {
    accessToken: string;
    owner: string;
    repo: string;
    request: DeploymentProvisioningRequestDto | undefined;
  },
): Promise<string | undefined> {
  const registry = support.workflowFragmentRegistry;
  const { request } = input;
  if (
    !request?.enabled ||
    !request.targets.some(
      (target) => registry?.deliveredByHost(target.provider) ?? false,
    )
  ) {
    return undefined;
  }

  const source = resolveReleaseSigningSource((key) =>
    support.configService?.get<string>(key),
  );
  if (source.kind === 'invalid-kms') return warn(INVALID_KMS_WARNING);
  if (source.kind === 'none') return warn(NOT_CONFIGURED_WARNING);

  const where = `${input.owner}/${input.repo}`;
  try {
    if (source.kind === 'kms') {
      await support.githubService.setActionsVariableStrict(
        input.accessToken,
        input.owner,
        input.repo,
        RELEASE_SIGNING_VARIABLE,
        source.keyVersion,
      );
      return undefined;
    }
    const pem = await readLabSigningKey(source.keyPath);
    await support.githubService.setActionsSecretStrict(
      input.accessToken,
      input.owner,
      input.repo,
      RELEASE_SIGNING_SECRET,
      pem,
    );
    return undefined;
  } catch (error) {
    const needed =
      source.kind === 'kms'
        ? `the repository variable ${RELEASE_SIGNING_VARIABLE}`
        : `the repository secret ${RELEASE_SIGNING_SECRET}`;
    return warn(
      `Release signing could not be configured on ${where}: ${describeError(error)}. Releases cannot be signed until ${needed} is set.`,
    );
  }
}

/**
 * Reads the lab signing key and checks that it is a P-256 private key. Lab only:
 * client hosts sign with Cloud KMS. Errors name the setting, never the file's
 * contents.
 */
export async function readLabSigningKey(keyPath: string): Promise<string> {
  let pem: string;
  try {
    pem = await readFile(keyPath, 'utf8');
  } catch {
    throw new Error(
      `${RELEASE_SIGNING_LAB_KEY_PATH_ENV} points to a file that cannot be read`,
    );
  }
  let namedCurve: string | undefined;
  let keyType: string;
  try {
    const key = createPrivateKey(pem);
    keyType = key.asymmetricKeyType ?? '';
    namedCurve = key.asymmetricKeyDetails?.namedCurve;
  } catch {
    throw new Error(
      `${RELEASE_SIGNING_LAB_KEY_PATH_ENV} does not contain a PEM private key`,
    );
  }
  if (keyType !== 'ec' || namedCurve !== 'prime256v1') {
    throw new Error(
      `${RELEASE_SIGNING_LAB_KEY_PATH_ENV} must contain a P-256 private key`,
    );
  }
  return pem;
}

/** Adds the warning to a create or setup response, leaving it untouched otherwise. */
export function withReleaseSigningWarning<T extends object>(
  response: T,
  warning: string | undefined,
): T {
  return warning === undefined
    ? response
    : { ...response, releaseSigningWarning: warning };
}

/** Combines per-repository warnings into the one a multi-repository response carries. */
export function joinReleaseSigningWarnings(
  ...warnings: Array<string | undefined>
): string | undefined {
  const present = warnings.filter((warning): warning is string =>
    Boolean(warning),
  );
  return present.length > 0 ? present.join(' ') : undefined;
}

function warn(message: string): string {
  logger.warn(message);
  return message;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
