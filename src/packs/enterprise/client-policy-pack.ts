import { readFileSync } from 'node:fs';

import type { AppConfig } from '#kernel/config/app.config.js';
import { assertPolicyAppliesTo } from '#kernel/composition/client-policy.js';
import type { ClientPolicyPack } from '#kernel/composition/client-policy-pack.port.js';
import type { ClientPolicySource } from '#kernel/composition/client-policy.port.js';
import type { ClientPolicyRegistry } from '#kernel/composition/client-policy.types.js';
import { PACK_MANIFESTS } from '#kernel/composition/manifests.js';
import { CLIENT_POLICIES } from './clients/index.js';
import { parseClientPolicyDocument } from './client-policy.js';
import {
  NullClientPolicySource,
  SingleClientPolicySource,
} from './client-policy-source.js';

export interface EnterpriseClientPolicyPackDeps {
  readonly policies?: ClientPolicyRegistry;
  readonly readFile?: (path: string) => string;
}

/** Create the real Enterprise policy pack, with injectable source seams for tests. */
export function createEnterpriseClientPolicyPack(
  deps: EnterpriseClientPolicyPackDeps = {},
): ClientPolicyPack {
  const policies = deps.policies ?? CLIENT_POLICIES;
  const readFile = deps.readFile ?? defaultReadFile;

  return {
    edition: 'enterprise',
    createSource(composition): ClientPolicySource {
      return createEnterpriseClientPolicySource(composition, {
        policies,
        readFile,
      });
    },
  };
}

/**
 * The public pack symbol loaded by the profile-keyed kernel seam.
 *
 * Its uppercase name is deliberate: build-profile artifact scans use this
 * real implementation symbol, not a marker-only file, to prove exclusion.
 */
export const EnterpriseClientPolicyPack = createEnterpriseClientPolicyPack();

export function createEnterpriseClientPolicySource(
  composition: AppConfig['composition'],
  deps: EnterpriseClientPolicyPackDeps = {},
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
          'Declare the client in the Enterprise client-policy pack or supply ' +
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
