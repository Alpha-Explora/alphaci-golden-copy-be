import type { ClientPolicyRegistry } from '#kernel/composition/client-policy.types.js';

/**
 * Declared Enterprise policies are deliberately empty until an operator adds
 * a real client. Mounted JSON remains the preferred deployment-specific seam.
 */
export const CLIENT_POLICIES: ClientPolicyRegistry = {};
