/**
 * The on-prem agent version this backend ships with. It must equal the
 * `version` in deploy/onprem/agent/release-manifest.json (the spec beside this
 * file enforces that), so an install that leaves ONPREM_INSTALLER_VERSION
 * unset offers the current agent rather than an old one.
 */
export const ONPREM_AGENT_VERSION = '0.4.3';
