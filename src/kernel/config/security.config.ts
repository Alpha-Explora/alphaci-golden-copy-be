/**
 * security.config.ts
 *
 * Centralised security configuration consumed by main.ts.
 * This file is CISO-owned — do not add application logic here.
 *
 * Exports:
 *   helmetConfig          - Helmet options for production hardening
 *   helmetConfigSwagger   - Relaxed Helmet options that allow Swagger UI to render
 *   corsOptions           - CORS factory; call with the ALLOWED_ORIGINS env string
 *   BODY_SIZE_LIMIT       - Maximum accepted request body size
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

export const BODY_SIZE_LIMIT = '5mb';

// ---------------------------------------------------------------------------
// Helmet
// ---------------------------------------------------------------------------

/**
 * Production Helmet configuration.
 *
 * Threat addressed:
 *   - XSS via injected scripts (CSP + noSniff)
 *   - Clickjacking (frameOptions / frame-ancestors)
 *   - Protocol downgrade / MITM (HSTS)
 *   - MIME sniffing attacks (noSniff)
 *   - Referrer leakage to third parties (referrerPolicy)
 *
 * Used when ENABLE_SWAGGER is false (production / staging).
 */
export const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    // 1 year in seconds; includeSubDomains prevents subdomain downgrade attacks
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' as const },
  // X-Frame-Options is set via frameAncestors above; disable the legacy header
  // to avoid duplicate/conflicting directives on older clients
  frameguard: false,
};

/**
 * Swagger-mode Helmet configuration.
 *
 * Swagger UI requires:
 *   - unsafe-inline for its dynamically generated <style> and <script> blocks
 *   - data: URIs for inline SVG icons
 *
 * ONLY enable this in development/local environments where ENABLE_SWAGGER=true.
 * Never expose Swagger in production — the broader CSP here is intentional for
 * local DX only and is not acceptable in production.
 */
export const helmetConfigSwagger = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  referrerPolicy: { policy: 'no-referrer' as const },
  frameguard: false,
};

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * corsOptions — CORS configuration factory.
 *
 * @param allowedOriginsEnv   Comma-separated exact origins.
 *                            Example: "http://localhost:3000,https://app.example.com"
 * @param allowedPatternsEnv  Comma-separated regex patterns for origins that
 *                            change per deployment (e.g. Vercel preview URLs).
 *                            Example: "https://my-app-[^.]+\\.vercel\\.app"
 *
 * Security invariants:
 *   1. Exact-match whitelist is checked first.
 *   2. Pattern matching requires HTTPS — plain-HTTP patterns are rejected.
 *   3. Wildcard (*) is never returned for credentialed requests.
 *   4. No origin → allowed (server-to-server / health probes).
 */
export function corsOptions(
  allowedOriginsEnv?: string,
  allowedPatternsEnv?: string,
): CorsOptions {
  const whitelist = new Set(
    (allowedOriginsEnv ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

  // Compile patterns once at startup — invalid regex is silently skipped.
  const patterns: RegExp[] = (allowedPatternsEnv ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .flatMap((p) => {
      try {
        return [new RegExp(`^${p}$`)];
      } catch {
        return [];
      }
    });

  function isAllowed(origin: string): boolean {
    if (whitelist.has(origin)) return true;
    // Only allow HTTPS origins via pattern — never plain HTTP in production.
    if (origin.startsWith('https://')) {
      return patterns.some((re) => re.test(origin));
    }
    return false;
  }

  return {
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, origin?: boolean | string) => void,
    ) => {
      if (!requestOrigin) {
        // Server-to-server / CLI / health-check probe — no browser origin.
        callback(null, true);
        return;
      }

      if (isAllowed(requestOrigin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-ID',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Correlation-ID', 'X-Request-Id'],
    credentials: true,
    maxAge: 86400,
  };
}
