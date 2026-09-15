import type { ClientPolicyRegistry } from '#kernel/composition/client-policy.types.js';

/**
 * Declared Enterprise policies ship with the product. Mounted JSON remains the
 * preferred deployment-specific seam when a policy should stay outside code.
 */
export const CLIENT_POLICIES: ClientPolicyRegistry = {
  northwind: {
    clientId: 'northwind',
    displayName: 'Northwind Industries',
    edition: 'enterprise',
    disabledCapabilities: ['runtime.preview-deployments'],
  },
};
