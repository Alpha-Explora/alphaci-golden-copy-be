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

const PROBE_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 5 * 60 * 1_000;
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
    return PROBEABLE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  }

  private async probe(url: string): Promise<EmbeddabilityVerdict> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        // A redirect could land somewhere off the allowlist, which would
        // defeat the check above, so a redirect is a non-answer rather than
        // something to follow.
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      return this.verdictFromHeaders(
        response.headers.get('x-frame-options'),
        response.headers.get('content-security-policy'),
      );
    } catch {
      // Timeouts and DNS failures are expected while a preview is still
      // building, so this is debug-level rather than a warning.
      this.logger.debug(`Embeddability probe did not complete for ${url}`);
      return {
        embeddable: null,
        reason: 'Could not reach the deployment to check embedding support.',
      };
    }
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
    this.cache.set(url, { verdict, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
