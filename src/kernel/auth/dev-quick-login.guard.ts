import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { AppConfig } from '#kernel/config/app.config';

/**
 * Protects the local development fixture-login endpoint.
 *
 * This intentionally has stricter requirements than DevOnlyGuard. The
 * endpoint is enabled only by an explicit development flag and is reachable
 * only from a loopback request. A missing or unrecognized condition is hidden
 * as a 404 so it does not become a discoverable authentication surface.
 */
@Injectable()
export class DevQuickLoginGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.isEnabled()) {
      throw new NotFoundException();
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      throw new NotFoundException();
    }

    if (!isLoopbackHostname(extractHostname(request.headers.host))) {
      throw new NotFoundException();
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      throw new NotFoundException();
    }

    return true;
  }

  private isEnabled(): boolean {
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    const appConfig = this.configService.get<AppConfig>('app');

    return (
      nodeEnv === 'development' &&
      appConfig?.auth?.devQuickLoginEnabled === true
    );
  }
}

function extractHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }

  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']');
    return closingBracket > 1
      ? trimmed.slice(1, closingBracket).toLowerCase()
      : null;
  }

  const portSeparator = trimmed.indexOf(':');
  return (
    portSeparator === -1 ? trimmed : trimmed.slice(0, portSeparator)
  ).toLowerCase();
}

function isLoopbackHostname(hostname: string | null): boolean {
  if (!hostname) {
    return false;
  }

  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    isIpv4Loopback(normalized)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const normalized = address.trim().toLowerCase();
  const unmapped = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;

  return (
    unmapped === '::1' ||
    unmapped === '0:0:0:0:0:0:0:1' ||
    isIpv4Loopback(unmapped)
  );
}

function isIpv4Loopback(value: string): boolean {
  const octets = value.split('.');
  if (octets.length !== 4 || !octets.every((octet) => /^\d+$/.test(octet))) {
    return false;
  }

  const numbers = octets.map(Number);
  return (
    numbers[0] === 127 && numbers.every((octet) => octet >= 0 && octet <= 255)
  );
}
