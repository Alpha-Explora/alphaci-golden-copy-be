import { Logger } from '@nestjs/common';

import {
  RELEASE_TRUST_KEYS_ENV,
  resolveReleaseSigningSource,
} from '#kernel/config/release-signing.config';
import {
  kmsTrustProblem,
  labTrustProblem,
  readLabSigningKey,
} from '#kernel/config/release-signing-key';
import {
  targetsForEnvironment,
  type EnvironmentScopedTarget,
} from '../../domain/environment-deployment-targets.policy';
import type { ProjectProvisioningSupport } from './project-provisioning.support';

/** Repository variable the release-signing job reads for Cloud KMS signing. */
export const RELEASE_SIGNING_VARIABLE = 'ALPHACI_RELEASE_KMS_KEY_VERSION';
/** Repository secret the release-signing job reads for the lab key (lab only). */
export const RELEASE_SIGNING_SECRET = 'ALPHACI_RELEASE_SIGNING_KEY';

const logger = new Logger('ReleaseSigningProvisioning');

const NOT_CONFIGURED_WARNING =
  "Releases cannot be signed yet: AlphaCI has no complete Cloud KMS signing configuration. Set ALPHACI_RELEASE_KMS_KEY_VERSION, ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER and ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT on the AlphaCI backend, regenerate this project's workflows, then add the repository variable ALPHACI_RELEASE_KMS_KEY_VERSION.";

/**
 * The environment's targets that decide whether this project's pipeline has a
 * sign-release job: the first environment's own and shared targets. Later
 * environments never get that job.
 */
export function firstEnvironmentTargets<Target extends EnvironmentScopedTarget>(
  environments: readonly { slug: string }[] | undefined,
  targets: readonly Target[],
): Target[] {
  const first = environments?.[0];
  return first ? targetsForEnvironment(targets, first.slug) : [];
}

/**
 * Configures release signing for a repository whose pipeline signs releases.
 *
 * The generated sign-release job exists only when every first-environment
 * target is host-delivered, so nothing is configured otherwise. Writes the
 * Cloud KMS key version as a repository variable, or, lab only, the lab key as a
 * repository secret. Returns a warning for the create response when releases
 * cannot be signed, or when the trust setting would not verify them. It never
 * throws: a signing gap must not roll back a repository that is otherwise
 * usable. Key material is never logged or returned.
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
    firstEnvironmentTargets: readonly { provider: string }[];
  },
): Promise<string | undefined> {
  const registry = support.workflowFragmentRegistry;
  const targets = input.firstEnvironmentTargets;
  if (
    targets.length === 0 ||
    !targets.every(
      (target) => registry?.deliveredByHost(target.provider) ?? false,
    )
  ) {
    return undefined;
  }

  const read = (key: string) => support.configService?.get<string>(key);
  const source = resolveReleaseSigningSource(read);
  if (source.kind === 'invalid') {
    return warn(
      `Releases cannot be signed: ${source.problem} Correct it, regenerate this project's workflows, then add the repository variable ALPHACI_RELEASE_KMS_KEY_VERSION.`,
    );
  }
  if (source.kind === 'none') return warn(NOT_CONFIGURED_WARNING);

  const where = `${input.owner}/${input.repo}`;
  const trustKeys = read(RELEASE_TRUST_KEYS_ENV);
  let trustProblem: string | undefined;
  try {
    if (source.kind === 'kms') {
      await support.githubService.setActionsVariableStrict(
        input.accessToken,
        input.owner,
        input.repo,
        RELEASE_SIGNING_VARIABLE,
        source.keyVersion,
      );
      trustProblem = kmsTrustProblem(source.keyVersion, trustKeys);
    } else {
      const pem = await readLabSigningKey(source.keyPath);
      await support.githubService.setActionsSecretStrict(
        input.accessToken,
        input.owner,
        input.repo,
        RELEASE_SIGNING_SECRET,
        pem,
      );
      trustProblem = labTrustProblem(pem, trustKeys);
    }
  } catch (error) {
    const needed =
      source.kind === 'kms'
        ? `the repository variable ${RELEASE_SIGNING_VARIABLE}`
        : `the repository secret ${RELEASE_SIGNING_SECRET}`;
    return warn(
      `Release signing could not be configured on ${where}: ${describeError(error)}. Releases cannot be signed until ${needed} is set.`,
    );
  }
  return trustProblem === undefined
    ? undefined
    : warn(
        `Releases from ${where} will not verify on their hosts yet. ${trustProblem}`,
      );
}

/** Adds the warning to a create response, leaving it untouched otherwise. */
export function withReleaseSigningWarning<T extends object>(
  response: T,
  warning: string | undefined,
): T {
  return warning === undefined
    ? response
    : { ...response, releaseSigningWarning: warning };
}

function warn(message: string): string {
  logger.warn(message);
  return message;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
