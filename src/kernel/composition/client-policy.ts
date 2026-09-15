import { CAPABILITIES } from './capability-registry.js';
import type {
  CapabilityKey,
  CapabilityManifest,
  Edition,
} from './capability-types.js';
import type { ClientCapabilityPolicy } from './client-policy.types.js';

export const CLIENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const EDITIONS: readonly Edition[] = ['saas', 'edu', 'enterprise'];
const POLICY_FIELDS = new Set([
  'clientId',
  'displayName',
  'edition',
  'disabledCapabilities',
]);
const REGISTRY_KEYS: ReadonlySet<string> = new Set(
  CAPABILITIES.map((record) => record.key),
);

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
 * Validate a client policy document from an untrusted source.
 *
 * Deployment-supplied policies arrive as JSON on a customer-controlled disk,
 * so every field is checked and every unknown field is rejected. A typo that
 * silently widened a deployment would defeat the point of the layer.
 */
export function parseClientPolicyDocument(
  value: unknown,
  origin: string,
): ClientCapabilityPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[composition] ${origin} must contain a JSON object.`);
  }

  const document = value as Record<string, unknown>;
  for (const field of Object.keys(document)) {
    if (POLICY_FIELDS.has(field)) continue;
    throw new Error(
      `[composition] ${origin} has unknown field '${field}'. ` +
        'A client policy may only remove capabilities; allowed fields are ' +
        'clientId, displayName, edition, and disabledCapabilities.',
    );
  }

  const clientId = parseClientId(document['clientId']);
  if (clientId === null) {
    throw new Error(`[composition] ${origin} is missing clientId.`);
  }

  const edition = document['edition'];
  if (!isEdition(edition)) {
    throw new Error(
      `[composition] ${origin} has invalid edition '${String(edition)}'. ` +
        `Allowed values: ${EDITIONS.join(', ')}.`,
    );
  }

  const rawName = document['displayName'];
  if (rawName !== undefined && typeof rawName !== 'string') {
    throw new Error(`[composition] ${origin} has a non-string displayName.`);
  }
  const displayName =
    typeof rawName === 'string' && rawName.trim() !== ''
      ? rawName.trim()
      : clientId;

  const disabled = document['disabledCapabilities'];
  if (!Array.isArray(disabled)) {
    throw new Error(
      `[composition] ${origin} must declare disabledCapabilities as an array.`,
    );
  }

  const seen = new Set<string>();
  for (const entry of disabled) {
    if (typeof entry !== 'string') {
      throw new Error(
        `[composition] ${origin} lists a non-string capability key.`,
      );
    }
    if (!REGISTRY_KEYS.has(entry)) {
      throw new Error(
        `[composition] ${origin} lists unknown capability '${entry}'.`,
      );
    }
    if (seen.has(entry)) {
      throw new Error(
        `[composition] ${origin} lists capability '${entry}' twice.`,
      );
    }
    seen.add(entry);
  }

  return {
    clientId,
    displayName,
    edition,
    disabledCapabilities: [...seen] as readonly CapabilityKey[],
  };
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

function isEdition(value: unknown): value is Edition {
  return typeof value === 'string' && EDITIONS.includes(value as Edition);
}
