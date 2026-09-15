import { readFileSync } from 'node:fs';

import type { AppConfig } from '#kernel/config/app.config.types.js';
import type { CompositionSubject } from './capability-resolver.port.js';
import type { ClientPolicySource } from './client-policy.port.js';
import type {
  ClientCapabilityPolicy,
  ClientPolicyRegistry,
} from './client-policy.types.js';
import {
  applyClientPolicy,
  assertPolicyAppliesTo,
  parseClientPolicyDocument,
} from './client-policy.js';
import { CLIENT_POLICIES } from './clients/index.js';
import { PACK_MANIFESTS } from './manifests.js';

export { applyClientPolicy };

/** A deployment with no client selected. The edition manifest stands unnarrowed. */
export class NullClientPolicySource implements ClientPolicySource {
  deployment(): ClientCapabilityPolicy | null {
    return null;
  }

  for(subject: CompositionSubject): ClientCapabilityPolicy | null {
    void subject;
    return null;
  }
}

/**
 * A deployment dedicated to one client.
 *
 * The subject argument is accepted and ignored on purpose: a hosted source
 * that varies the policy per tenant replaces this class without touching the
 * resolver, the guard, or any controller.
 */
export class SingleClientPolicySource implements ClientPolicySource {
  constructor(private readonly policy: ClientCapabilityPolicy) {}

  deployment(): ClientCapabilityPolicy {
    return this.policy;
  }

  for(subject: CompositionSubject): ClientCapabilityPolicy {
    void subject;
    return this.policy;
  }
}

export interface ClientPolicySourceDeps {
  readonly policies?: ClientPolicyRegistry;
  readonly readFile?: (path: string) => string;
}

/**
 * Select the client policy source for this deployment, failing closed.
 *
 * `ALPHACI_CLIENT_CONFIG` wins when both are set, because a deployment-supplied
 * file is the more specific statement, but the file must then name the same
 * client as `ALPHACI_CLIENT`. A mismatch means the operator mounted the wrong
 * policy, which is worth a failed boot rather than a silently wrong product.
 */
export function createClientPolicySource(
  composition: AppConfig['composition'],
  deps: ClientPolicySourceDeps = {},
): ClientPolicySource {
  const policies = deps.policies ?? CLIENT_POLICIES;
  const readFile = deps.readFile ?? defaultReadFile;
  const manifest = PACK_MANIFESTS[composition.edition];
  const { id, configPath } = composition.client;

  if (configPath !== null) {
    const origin = `ALPHACI_CLIENT_CONFIG '${configPath}'`;
    const policy = parseClientPolicyDocument(
      readPolicyDocument(configPath, readFile, origin),
      origin,
    );
    if (id !== null && policy.clientId !== id) {
      throw new Error(
        `[composition] ${origin} declares client '${policy.clientId}' ` +
          `but ALPHACI_CLIENT is '${id}'.`,
      );
    }
    assertPolicyAppliesTo(policy, manifest, origin);
    return new SingleClientPolicySource(policy);
  }

  if (id !== null) {
    const policy = policies[id];
    if (policy === undefined) {
      const declared = Object.keys(policies);
      throw new Error(
        `[composition] Unknown ALPHACI_CLIENT '${id}'. ` +
          `Declared clients: ${declared.length > 0 ? declared.join(', ') : 'none'}. ` +
          'Declare the client in src/kernel/composition/clients or supply ' +
          'ALPHACI_CLIENT_CONFIG.',
      );
    }
    assertPolicyAppliesTo(policy, manifest, `client policy '${id}'`);
    return new SingleClientPolicySource(policy);
  }

  return new NullClientPolicySource();
}

function readPolicyDocument(
  path: string,
  readFile: (path: string) => string,
  origin: string,
): unknown {
  let contents: string;
  try {
    contents = readFile(path);
  } catch (cause) {
    throw new Error(`[composition] Cannot read ${origin}: ${describe(cause)}`);
  }

  try {
    return JSON.parse(contents);
  } catch (cause) {
    throw new Error(
      `[composition] ${origin} is not valid JSON: ${describe(cause)}`,
    );
  }
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
