import { createHash } from 'node:crypto';

/**
 * The on-prem counterpart of the cross-linked service URLs a two-repository
 * project gets on Vercel and Render: when the backend project and the
 * frontend project of one pair run the same environment on the same machine,
 * both containers join one Docker network and the frontend reaches the
 * backend by its network alias.
 *
 * A link is derived each time a machine reads its assignments and is never
 * stored, so assigning, unassigning or moving either side changes it on the
 * next read.
 */
export type LinkedSlot = 'frontend' | 'backend';

/** One environment binding on the machine, as the derivation needs it. */
export interface ServiceLinkCandidate {
  projectId: string;
  environmentId: string;
  /** The environment's slug: the two halves of a pair match on it. */
  slug: string;
  ports: ReadonlyArray<{ slot: LinkedSlot; containerPort: number }>;
  /** Where users reach the environment (tunnel or configured URL), if known. */
  publicAddress: string | null;
}

/** What the agent applies: one external network and runtime variables per slot. */
export interface ServiceLink {
  /** Docker network both containers join; each is aliased by its slot. */
  network: string;
  /** Runtime variables written into the slot's Compose `environment`. */
  env: Partial<Record<LinkedSlot, Record<string, string>>>;
  /**
   * The other half's environment and slot. The agent connects that running
   * container to the network too, so the first linked deployment of either
   * side works without waiting for the other side to redeploy.
   */
  peers: Array<{ environmentId: string; slot: LinkedSlot }>;
}

/** The agent release that applies links; older agents deploy without them. */
export const SERVICE_LINK_AGENT_VERSION = '0.4.0';

/** Docker network names allow [a-zA-Z0-9][a-zA-Z0-9_.-]; the agent accepts this subset. */
export const SERVICE_LINK_NETWORK =
  /^alphaci-[a-f0-9]{12}-[a-z0-9][a-z0-9-]{0,23}$/;
/** Runtime variable names the agent accepts. */
export const SERVICE_LINK_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `alphaci-<pair>-<environment slug>`: the pair part hashes both environment
 * ids, so it is the same for both halves and differs for every pair.
 */
export function serviceLinkNetwork(
  backendEnvironmentId: string,
  frontendEnvironmentId: string,
  slug: string,
): string {
  const pair = createHash('sha256')
    .update(`${backendEnvironmentId}:${frontendEnvironmentId}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
  const label =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'env';
  return `alphaci-${pair}-${label}`;
}

const onlySlot = (candidate: ServiceLinkCandidate): LinkedSlot | null =>
  candidate.ports.length === 1 ? candidate.ports[0]!.slot : null;

/**
 * The link of `self`, given the machine's other bindings that belong to the
 * same delivery project (the shared "Project" folder a two-repository pair is
 * filed under). Null, so the environment deploys exactly as a single app,
 * unless the machine runs exactly one backend-only and one frontend-only
 * environment with self's slug in that folder, from two different projects,
 * and self is one of them.
 */
export function deriveServiceLink(
  self: ServiceLinkCandidate,
  folderBindings: ReadonlyArray<ServiceLinkCandidate>,
): ServiceLink | null {
  const sameSlug = folderBindings.filter((item) => item.slug === self.slug);
  const backends = sameSlug.filter((item) => onlySlot(item) === 'backend');
  const frontends = sameSlug.filter((item) => onlySlot(item) === 'frontend');
  if (backends.length !== 1 || frontends.length !== 1) return null;
  const backend = backends[0]!;
  const frontend = frontends[0]!;
  if (backend.projectId === frontend.projectId) return null;
  const network = serviceLinkNetwork(
    backend.environmentId,
    frontend.environmentId,
    self.slug,
  );
  if (self.environmentId === frontend.environmentId)
    return {
      network,
      env: {
        frontend: {
          API_URL: `http://backend:${backend.ports[0]!.containerPort}`,
        },
      },
      peers: [{ environmentId: backend.environmentId, slot: 'backend' }],
    };
  if (self.environmentId === backend.environmentId) {
    const address = frontendAddress(frontend.publicAddress);
    return {
      network,
      env: address
        ? {
            backend: {
              FRONTEND_URL: address.url,
              CORS_ORIGINS: address.origin,
            },
          }
        : {},
      peers: [{ environmentId: frontend.environmentId, slot: 'frontend' }],
    };
  }
  return null;
}

/** An HTTP(S) address without credentials or line breaks, or null. */
function frontendAddress(
  value: string | null,
): { url: string; origin: string } | null {
  if (!value || /[\s"'\\$`]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;
  return { url: value.replace(/\/+$/, ''), origin: url.origin };
}
