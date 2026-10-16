import { configureRepositoryReleaseSigning } from '#kernel/config/release-signing-provisioning';
import type { ProjectProvisioningSupport } from './project-provisioning.support';

/**
 * Configures release signing for a repository being provisioned. Called once
 * per project at creation with every requested target: an environment pipeline
 * signs its release once, and any host-delivered target, in any environment,
 * consumes that release. The shared rules live in the kernel so the runtime
 * can apply them when a target is added later.
 */
export function configureReleaseSigning(
  support: Pick<
    ProjectProvisioningSupport,
    'githubService' | 'configService' | 'workflowFragmentRegistry'
  >,
  input: {
    accessToken: string;
    owner: string;
    repo: string;
    targets: readonly { provider: string }[];
  },
): Promise<string | undefined> {
  return configureRepositoryReleaseSigning({
    github: support.githubService,
    read: (key) => support.configService?.get<string>(key),
    deliveredByHost: (provider) =>
      support.workflowFragmentRegistry?.deliveredByHost(provider) ?? false,
    accessToken: input.accessToken,
    owner: input.owner,
    repo: input.repo,
    targets: input.targets,
    untrusted: 'write-and-warn',
  });
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
