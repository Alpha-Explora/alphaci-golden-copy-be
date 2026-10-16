import type { InstallerRelease } from '../onprem/onprem-host.contracts';

export const ONPREM_INSTALLER_RELEASE = Symbol('OnpremInstallerRelease');

export interface OnpremInstallerReleaseLookup {
  /** owner/repo that publishes the `onprem-agent-v<version>` release. */
  repo: string;
  version: string;
  /**
   * Operator-pinned archive SHA-256, from configuration rather than from the
   * release. When set, the release's own metadata is not consulted.
   */
  pinnedSha256?: string | undefined;
  /** Optional GitHub token for API calls only. Never logged. */
  token?: string | undefined;
}

/**
 * Verified installer archive for one version of the on-prem agent. Resolves to
 * undefined whenever the archive cannot be verified, so enrollment can refuse
 * to issue a code.
 */
export interface OnpremInstallerReleasePort {
  resolve(
    lookup: OnpremInstallerReleaseLookup,
  ): Promise<InstallerRelease | undefined>;
}
