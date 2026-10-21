/**
 * Where a single-server install gives on-prem environments permanent
 * addresses: ONPREM_APPS_DOMAIN, and the optional ONPREM_APPS_LABEL_SUFFIX.
 *
 * Kept in the kernel because two halves of the product agree on it: the
 * assignment service names the addresses, and the embeddability probe may
 * only fetch names the service could have given.
 *
 * Without a suffix an address is `<label>.<domain>`, and one wildcard record
 * `*.<domain>` covers them all. With one it is `<label>-<suffix>.<domain>`,
 * still a single label under the domain. That suits a domain shared with
 * other names (a company zone whose free edge certificate covers one level
 * only): the suffix keeps the apps apart, and each address gets its own DNS
 * record, since a wildcard cannot cover part of a label.
 *
 * An invalid suffix turns app addresses off instead of being dropped, so apps
 * never land on the shared domain's bare names.
 */
export interface OnpremAppsDomain {
  domain: string;
  /** Empty when ONPREM_APPS_LABEL_SUFFIX is not set. */
  labelSuffix: string;
}

const LABEL_SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_LABEL = 63;

export function resolveOnpremAppsDomain(
  get: (key: string) => string | undefined = (key) => process.env[key],
): OnpremAppsDomain | undefined {
  const domain = get('ONPREM_APPS_DOMAIN')?.trim().toLowerCase();
  if (!domain) return undefined;
  const labelSuffix = get('ONPREM_APPS_LABEL_SUFFIX')?.trim().toLowerCase();
  if (!labelSuffix) return { domain, labelSuffix: '' };
  return LABEL_SUFFIX.test(labelSuffix) ? { domain, labelSuffix } : undefined;
}

/** The ending every address shares: `.<domain>`, or `-<suffix>.<domain>`. */
export function onpremAppsHostEnding(apps: OnpremAppsDomain): string {
  return apps.labelSuffix
    ? `-${apps.labelSuffix}.${apps.domain}`
    : `.${apps.domain}`;
}

/** `https://<name>[-<suffix>].<domain>`, the name cut so the label fits 63. */
export function onpremAppsAddress(
  apps: OnpremAppsDomain,
  name: string,
): string {
  const room = MAX_LABEL - (apps.labelSuffix ? apps.labelSuffix.length + 1 : 0);
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, room)
    .replace(/-+$/, '');
  return `https://${base}${onpremAppsHostEnding(apps)}`;
}
