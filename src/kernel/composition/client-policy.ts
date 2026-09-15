import type { CapabilityManifest } from './capability-types.js';
import type { ClientCapabilityPolicy } from './client-policy.types.js';

export const CLIENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Read `ALPHACI_CLIENT`, returning null when no client is selected. */
export function parseClientId(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return null;
  if (!CLIENT_ID_PATTERN.test(raw)) {
    throw new Error(
      `[composition] Invalid ALPHACI_CLIENT: '${raw}'. ` +
        'Use a lowercase slug of letters, digits, and hyphens, 1-40 characters.',
    );
  }
  return raw;
}

/**
 * Reject a policy that does not belong to the manifest it would narrow.
 *
 * Running one client's policy against another edition, or removing a key the
 * edition never had, is a configuration error rather than a no-op: it means
 * the operator believes something about this deployment that is not true.
 */
export function assertPolicyAppliesTo(
  policy: ClientCapabilityPolicy,
  manifest: CapabilityManifest,
  origin: string,
): void {
  if (policy.edition !== manifest.edition) {
    throw new Error(
      `[composition] ${origin} declares edition '${policy.edition}' ` +
        `but this deployment runs '${manifest.edition}'.`,
    );
  }

  const available = new Set<string>(manifest.capabilities);
  for (const key of policy.disabledCapabilities) {
    if (!available.has(key)) {
      throw new Error(
        `[composition] ${origin} disables '${key}', which the ` +
          `'${manifest.edition}' manifest does not contain.`,
      );
    }
  }
}

/** Remove the policy's capabilities from the manifest, preserving registry order. */
export function applyClientPolicy(
  manifest: CapabilityManifest,
  policy: ClientCapabilityPolicy | null,
): CapabilityManifest {
  if (policy === null || policy.disabledCapabilities.length === 0) {
    return manifest;
  }

  const disabled = new Set<string>(policy.disabledCapabilities);
  return {
    edition: manifest.edition,
    capabilities: manifest.capabilities.filter((key) => !disabled.has(key)),
  };
}
