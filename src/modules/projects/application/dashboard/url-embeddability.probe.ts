import { Injectable, Logger } from '@nestjs/common';

/**
 * Whether a deployed site can be shown inside an iframe.
 *
 * `null` means "could not determine" — the site did not answer in time or the
 * host was not one we are willing to probe. The UI must treat null as "do not
 * embed" while still offering the link, because a browser gives no error event
 * for an X-Frame-Options refusal: a page that silently fails to frame is
 * indistinguishable from one that is merely slow, so the decision has to be
 * made server-side rather than guessed with a client timeout.
 */
export interface EmbeddabilityVerdict {
  embeddable: boolean | null;
  /** Safe, user-facing reason. Never contains response bodies or headers. */
  reason: string | null;
}

/**
 * Hostname suffixes we will issue a probe request to.
 *
 * The URLs reaching this probe come from provider metadata and from Vercel's
 * own deployments API, so they are not directly user-authored — but they are
 * still the one place in this flow where an outbound request target is derived
 * from stored data, so it stays on an allowlist. Custom domains get added here
 * only once they are verified.
 */
const PROBEABLE_HOST_SUFFIXES = ['.vercel.app', '.onrender.com'] as const;

/**
 * Addresses AlphaCI itself gives on-prem environments: a Cloudflare quick
 * tunnel, or a name under this install's ONPREM_APPS_DOMAIN (single-server
 * installs). Without them every on-prem preview was refused a check, so QA
 * Studio never framed one.
 */
function onpremHostSuffixes(): string[] {
  const domain = process.env['ONPREM_APPS_DOMAIN']?.trim().toLowerCase();
  return ['.trycloudflare.com', ...(domain ? [`.${domain}`] : [])];
}

/**
 * Hosts a deployment redirects to when it is behind deployment protection.
 *
 * Vercel Authentication answers an unauthenticated visitor with a redirect to
 * vercel.com/sso-api. That redirect also carries X-Frame-Options: DENY, so
 * reading its headers as the site's own blamed the site for a sign-in wall
 * the provider put in front of it.
 */
const SIGN_IN_REDIRECT_HOSTS = ['vercel.com'] as const;

/**
 * Same-host hops followed before giving up. A production site commonly
 * redirects `/` to `/login` or a locale path, and the page that finally
 * answers is the one that decides whether it can be framed.
 */
const MAX_SAME_HOST_REDIRECTS = 3;

const PROBE_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
/**
 * An unreachable deployment is checked again soon: right after a deploy (a new
 * address still getting its certificate, a container still starting) the first
 * probe often misses, and caching that for five minutes left the preview stuck
 * on "Could not reach" long after the site was up.
 */
const UNREACHABLE_CACHE_TTL_MS = 15 * 1_000;
const UNREACHABLE_REASON =
  'Could not reach the deployment to check embedding support.';
/** Bounded so a project churning through preview URLs cannot grow this without limit. */
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  verdict: EmbeddabilityVerdict;
  expiresAt: number;
}

@Injectable()
export class UrlEmbeddabilityProbe {
  private readonly logger = new Logger(UrlEmbeddabilityProbe.name);
  private readonly cache = new Map<string, CacheEntry>();

  async check(url: string | null): Promise<EmbeddabilityVerdict> {
    if (!url) {
      return { embeddable: null, reason: null };
    }

    if (!this.isProbeableUrl(url)) {
      return {
        embeddable: null,
        reason: 'This host is not checked for embedding support.',
      };
    }

    const cached = this.readCache(url);
    if (cached) {
      return cached;
    }

    const verdict = await this.probe(url);
    this.writeCache(url, verdict);
    return verdict;
  }

  /**
   * Only absolute http(s) URLs on an allowlisted host. Everything else is
   * refused rather than probed — this is the SSRF boundary, so it rejects by
   * default and an unparseable URL is not a special case.
   */
  private isProbeableUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    return [...PROBEABLE_HOST_SUFFIXES, ...onpremHostSuffixes()].some(
      (suffix) => host.endsWith(suffix),
    );
  }

  private async probe(url: string): Promise<EmbeddabilityVerdict> {
    try {
      let current = url;
      for (let hop = 0; hop <= MAX_SAME_HOST_REDIRECTS; hop += 1) {
        const response = await fetch(current, {
          method: 'HEAD',
          // Redirects are read here rather than followed by fetch: an
          // automatic follow could land off the allowlist, which would defeat
          // the check above. Only a same-host hop is taken.
          redirect: 'manual',
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });

        const next = this.sameHostRedirect(current, response);
        if (!next) {
          return this.verdictFromResponse(current, response);
        }
        current = next.href;
      }

      return {
        embeddable: null,
        reason: 'The deployment redirects too many times to check.',
      };
    } catch {
      // Timeouts and DNS failures are expected while a preview is still
      // building, so this is debug-level rather than a warning.
      this.logger.debug(`Embeddability probe did not complete for ${url}`);
      return {
        embeddable: null,
        reason: UNREACHABLE_REASON,
      };
    }
  }

  /** The next URL when this response is a redirect that stays on the host. */
  private sameHostRedirect(current: string, response: Response): URL | null {
    const target = this.redirectTarget(current, response);
    return target && target.host === new URL(current).host ? target : null;
  }

  private redirectTarget(current: string, response: Response): URL | null {
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return null;
    }
    try {
      return new URL(location, current);
    } catch {
      return null;
    }
  }

  /**
   * The verdict for the response that finally answered.
   *
   * A sign-in wall is checked before the framing headers: it is the reason
   * the page cannot be shown, and its own headers describe the wall rather
   * than the site behind it.
   */
  private verdictFromResponse(
    current: string,
    response: Response,
  ): EmbeddabilityVerdict {
    const target = this.redirectTarget(current, response);
    const signInRedirect =
      target !== null &&
      SIGN_IN_REDIRECT_HOSTS.some((host) => target.hostname === host);
    if (signInRedirect || response.status === 401 || response.status === 403) {
      return {
        embeddable: false,
        reason:
          'This deployment is behind deployment protection, so it cannot be shown inline. Open it in a new tab while signed in to the provider.',
      };
    }
    if (target) {
      return {
        embeddable: null,
        reason:
          'The deployment redirects to another site, so embedding support was not checked.',
      };
    }

    return this.verdictFromHeaders(
      response.headers.get('x-frame-options'),
      response.headers.get('content-security-policy'),
    );
  }

  private verdictFromHeaders(
    xFrameOptions: string | null,
    contentSecurityPolicy: string | null,
  ): EmbeddabilityVerdict {
    const xfo = xFrameOptions?.trim().toUpperCase();
    if (xfo === 'DENY') {
      return {
        embeddable: false,
        reason: 'The site sends X-Frame-Options: DENY.',
      };
    }
    if (xfo === 'SAMEORIGIN' || xfo?.startsWith('ALLOW-FROM')) {
      // SAMEORIGIN blocks us because the dashboard is a different origin, and
      // ALLOW-FROM is deprecated and ignored by current browsers — treating
      // either as embeddable would produce a blank frame.
      return {
        embeddable: false,
        reason: `The site restricts framing (X-Frame-Options: ${xfo}).`,
      };
    }

    const frameAncestors = this.frameAncestors(contentSecurityPolicy);
    if (frameAncestors && !frameAncestors.includes('*')) {
      return {
        embeddable: false,
        reason: "The site's Content-Security-Policy restricts framing.",
      };
    }

    return { embeddable: true, reason: null };
  }

  /**
   * The `frame-ancestors` source list, or null when the policy does not set
   * one. Anything other than an explicit wildcard is treated as blocking,
   * because this dashboard's origin varies per deployment and claiming
   * embeddable when it is not produces an unexplained blank frame.
   */
  private frameAncestors(policy: string | null): string[] | null {
    if (!policy) {
      return null;
    }

    for (const directive of policy.split(';')) {
      const parts = directive.trim().split(/\s+/);
      const name = parts.shift()?.toLowerCase();
      if (name === 'frame-ancestors') {
        return parts.map((source) => source.toLowerCase());
      }
    }

    return null;
  }

  private readCache(url: string): EmbeddabilityVerdict | null {
    const entry = this.cache.get(url);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(url);
      return null;
    }
    return entry.verdict;
  }

  private writeCache(url: string, verdict: EmbeddabilityVerdict): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    const ttl =
      verdict.reason === UNREACHABLE_REASON
        ? UNREACHABLE_CACHE_TTL_MS
        : CACHE_TTL_MS;
    this.cache.set(url, { verdict, expiresAt: Date.now() + ttl });
  }
}
