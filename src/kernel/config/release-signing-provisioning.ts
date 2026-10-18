import { Logger } from '@nestjs/common';

import {
  RELEASE_TRUST_KEYS_ENV,
  resolveReleaseSigningSource,
  serverSignsReleases,
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
 * What happens when the trust setting would not verify the releases:
 * - `write-and-warn` (provisioning): an untrusted Cloud KMS key version is written
 *   and the gap reported, because the variable is harmless. An untrusted lab key
 *   is still not written: a private key must not reach a repository that cannot
 *   verify releases.
 * - `refuse` (a user adding an on-prem target): nothing is written, and the gap is
 *   returned so the caller can refuse.
 */
export type UntrustedSigning = 'write-and-warn' | 'refuse';

/** One planned repository write, with the trust answer known before it runs. */
interface SigningWrite {
  trustProblem: string | undefined;
  write: () => Promise<void>;
}

/**
 * Configures release signing for one repository, given the targets that will
 * consume its releases. Signing is needed whenever any of them is host-delivered:
 * a host verifies the release that a pipeline signs, and every environment
 * shares that release, so one configuration covers the project.
 *
 * The trust check runs before any write. Cloud KMS needs only the key version,
 * and the lab key needs only its own PEM, so both are known before writing.
 *
 * Returns a message when releases from the repository cannot be signed, or when
 * the trust setting would not verify them. The message is undefined when all is
 * in place. It never throws for a configuration gap, so the caller decides
 * whether the gap is a refusal or a warning. Key material is never logged or
 * returned.
 */
export async function configureRepositoryReleaseSigning(input: {
  github: ReleaseSigningWriter;
  read: (key: string) => string | undefined;
  deliveredByHost: (provider: string) => boolean;
  accessToken: string;
  owner: string;
  repo: string;
  targets: readonly { provider: string }[];
  untrusted: UntrustedSigning;
}): Promise<string | undefined> {
  if (!input.targets.some((target) => input.deliveredByHost(target.provider))) {
    return undefined;
  }
  // The backend signs (ALPHACI_RELEASE_SIGNER=file): no signing setting reaches GitHub.
  if (serverSignsReleases(input.read)) return undefined;

  const source = resolveReleaseSigningSource(input.read);
  if (source.kind === 'invalid') {
    return warn(
      `Releases cannot be signed: ${source.problem} Correct it, regenerate this project's workflows, then try again.`,
    );
  }
  if (source.kind === 'none') return warn(NOT_CONFIGURED_WARNING);

  const where = `${input.owner}/${input.repo}`;
  const trustKeys = input.read(RELEASE_TRUST_KEYS_ENV);
  const needed =
    source.kind === 'kms'
      ? `the repository variable ${RELEASE_SIGNING_VARIABLE}`
      : `the repository secret ${RELEASE_SIGNING_SECRET}`;

  let plan: SigningWrite;
  try {
    plan =
      source.kind === 'kms'
        ? {
            trustProblem: kmsTrustProblem(source.keyVersion, trustKeys),
            write: () =>
              input.github.setActionsVariableStrict(
                input.accessToken,
                input.owner,
                input.repo,
                RELEASE_SIGNING_VARIABLE,
                source.keyVersion,
              ),
          }
        : await labSecretPlan(input, source.keyPath, trustKeys);
  } catch (error) {
    return warn(
      `Release signing could not be configured on ${where}: ${describeError(error)}. Releases cannot be signed until ${needed} is set.`,
    );
  }

  // An untrusted lab key is never written, even by provisioning: it would copy a
  // private key into the repository for releases that cannot verify. An untrusted
  // Cloud KMS variable is harmless, so provisioning writes it and warns.
  if (
    plan.trustProblem !== undefined &&
    (input.untrusted === 'refuse' || source.kind === 'lab')
  ) {
    return warn(
      `Releases from ${where} would not verify on their hosts, so ${needed} was not written. ${plan.trustProblem}`,
    );
  }

  try {
    await plan.write();
  } catch (error) {
    return warn(
      `Release signing could not be configured on ${where}: ${describeError(error)}. Releases cannot be signed until ${needed} is set.`,
    );
  }

  return plan.trustProblem === undefined
    ? undefined
    : warn(
        `Releases from ${where} will not verify on their hosts yet. ${plan.trustProblem}`,
      );
}

/** Reads the lab key, checks its trust, and plans the repository secret write. */
async function labSecretPlan(
  input: {
    github: ReleaseSigningWriter;
    accessToken: string;
    owner: string;
    repo: string;
  },
  keyPath: string,
  trustKeys: string | undefined,
): Promise<SigningWrite> {
  const pem = await readLabSigningKey(keyPath);
  return {
    trustProblem: labTrustProblem(pem, trustKeys),
    write: () =>
      input.github.setActionsSecretStrict(
        input.accessToken,
        input.owner,
        input.repo,
        RELEASE_SIGNING_SECRET,
        pem,
      ),
  };
}

function warn(message: string): string {
  logger.warn(message);
  return message;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unexpected error';
}
