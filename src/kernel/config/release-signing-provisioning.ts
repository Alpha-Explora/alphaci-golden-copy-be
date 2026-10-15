import { Logger } from '@nestjs/common';

import {
  RELEASE_TRUST_KEYS_ENV,
  resolveReleaseSigningSource,
} from './release-signing.config';
import {
  kmsTrustProblem,
  labTrustProblem,
  readLabSigningKey,
} from './release-signing-key';

/** Repository variable the release-signing job reads for Cloud KMS signing. */
export const RELEASE_SIGNING_VARIABLE = 'ALPHACI_RELEASE_KMS_KEY_VERSION';
/** Repository secret the release-signing job reads for the lab key (lab only). */
export const RELEASE_SIGNING_SECRET = 'ALPHACI_RELEASE_SIGNING_KEY';

const logger = new Logger('ReleaseSigning');

const NOT_CONFIGURED_WARNING =
  "Releases cannot be signed yet: AlphaCI has no complete Cloud KMS signing configuration. Set ALPHACI_RELEASE_KMS_KEY_VERSION, ALPHACI_RELEASE_SIGNER_WORKLOAD_IDENTITY_PROVIDER and ALPHACI_RELEASE_SIGNER_SERVICE_ACCOUNT on the AlphaCI backend, then regenerate this project's workflows so the sign-release job carries the signer identity.";

/** The two repository writes release signing needs. Both are strict: they throw on refusal. */
export interface ReleaseSigningWriter {
  setActionsSecretStrict(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void>;
  setActionsVariableStrict(
    accessToken: string,
    owner: string,
    repo: string,
    variableName: string,
    variableValue: string,
  ): Promise<void>;
}

/**
 * Configures release signing for one repository, given the targets that will
 * consume its releases. Signing is needed whenever any of them is host-delivered:
 * a host verifies the release that a pipeline signs, and every environment
 * shares that release, so one configuration covers the project.
 *
 * Writes the Cloud KMS key version as a repository variable, or, lab only, the
 * lab key as a repository secret. Returns a message when releases from the
 * repository cannot be signed, or when the trust setting would not verify them;
 * undefined when everything is in place. It never throws for a configuration
 * gap, so the caller decides whether the gap is a refusal or a warning. Key
 * material is never logged or returned.
 */
export async function configureRepositoryReleaseSigning(input: {
  github: ReleaseSigningWriter;
  read: (key: string) => string | undefined;
  deliveredByHost: (provider: string) => boolean;
  accessToken: string;
  owner: string;
  repo: string;
  targets: readonly { provider: string }[];
}): Promise<string | undefined> {
  if (!input.targets.some((target) => input.deliveredByHost(target.provider))) {
    return undefined;
  }

  const source = resolveReleaseSigningSource(input.read);
  if (source.kind === 'invalid') {
    return warn(
      `Releases cannot be signed: ${source.problem} Correct it, regenerate this project's workflows, then try again.`,
    );
  }
  if (source.kind === 'none') return warn(NOT_CONFIGURED_WARNING);

  const where = `${input.owner}/${input.repo}`;
  const trustKeys = input.read(RELEASE_TRUST_KEYS_ENV);
  let trustProblem: string | undefined;
  try {
    if (source.kind === 'kms') {
      await input.github.setActionsVariableStrict(
        input.accessToken,
        input.owner,
        input.repo,
        RELEASE_SIGNING_VARIABLE,
        source.keyVersion,
      );
      trustProblem = kmsTrustProblem(source.keyVersion, trustKeys);
    } else {
      const pem = await readLabSigningKey(source.keyPath);
      await input.github.setActionsSecretStrict(
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

function warn(message: string): string {
  logger.warn(message);
  return message;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
