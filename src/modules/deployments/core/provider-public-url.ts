import type { DeploymentTargetSummary } from './deployments.types';

/**
 * The public URL the deployed service answers on.
 *
 * Prefers the URL the provider handed back at creation (Render stores it in
 * providerMetadata) and falls back to each provider's deterministic naming
 * convention. Kept as a free function so both the target listing and the
 * deployment history can share one definition — the same conventions were
 * previously about to be spelled out a third time, and a provider changing
 * its hostname format should only need one edit here.
 */
export function providerPublicUrl(
  target: Pick<
    DeploymentTargetSummary,
    'provider' | 'providerProjectName' | 'providerMetadata'
  >,
): string | null {
  if (target.provider === 'render') {
    const metadataUrl = target.providerMetadata?.['renderServiceUrl'];
    if (typeof metadataUrl === 'string' && metadataUrl.trim()) {
      return metadataUrl.trim();
    }
    return target.providerProjectName
      ? `https://${target.providerProjectName}.onrender.com`
      : null;
  }

  if (target.provider === 'vercel') {
    return target.providerProjectName
      ? `https://${target.providerProjectName}.vercel.app`
      : null;
  }

  return null;
}
