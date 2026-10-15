import type { InstallerRelease } from '../onprem/onprem-host.contracts';

export const ONPREM_INSTALLER_RELEASE = Symbol('OnpremInstallerRelease');

/**
 * Verified installer archive for one version of the on-prem agent. Resolves to
 * undefined whenever the archive cannot be verified, so enrollment can refuse
 * to issue a code.
 */
export interface OnpremInstallerReleasePort {
  resolve(repo: string, version: string): Promise<InstallerRelease | undefined>;
}
