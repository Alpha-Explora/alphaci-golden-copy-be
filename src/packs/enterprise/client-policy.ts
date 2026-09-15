import { CAPABILITIES } from '#kernel/composition/capability-registry.js';
import { parseClientId } from '#kernel/composition/client-policy.js';
import type {
  CapabilityKey,
  Edition,
} from '#kernel/composition/capability-types.js';
import type { ClientCapabilityPolicy } from '#kernel/composition/client-policy.types.js';

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

/**
 * Validate an Enterprise policy document from an untrusted source.
 *
 * Mounted policies arrive as JSON on a customer-controlled disk, so every
 * field is checked and every unknown field is rejected. The Enterprise pack
 * owns this document vocabulary; the kernel only owns generic narrowing.
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

function isEdition(value: unknown): value is Edition {
  return typeof value === 'string' && EDITIONS.includes(value as Edition);
}
