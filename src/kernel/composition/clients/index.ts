import type { ClientPolicyRegistry } from '../client-policy.types.js';

/**
 * Client capability policies declared in this repository.
 *
 * A declared policy is reviewed, versioned, and gate-checked like any other
 * source. It suits a client whose composition should travel with the product.
 * A deployment that must supply its own policy without a release uses
 * `ALPHACI_CLIENT_CONFIG` instead, which carries the same document shape and
 * the same validation.
 *
 * Shape:
 *
 * ```ts
 * export const CLIENT_POLICIES: ClientPolicyRegistry = {
 *   'northwind': {
 *     clientId: 'northwind',
 *     displayName: 'Northwind Industries',
 *     edition: 'enterprise',
 *     disabledCapabilities: ['runtime.preview-deployments'],
 *   },
 * };
 * ```
 *
 * The registry is intentionally empty. An unknown `ALPHACI_CLIENT` fails at
 * boot rather than resolving to an unnarrowed Enterprise deployment.
 */
export const CLIENT_POLICIES: ClientPolicyRegistry = {};
