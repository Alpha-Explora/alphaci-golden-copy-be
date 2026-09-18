import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

import {
  type TenantContext,
  type TenantContextPort,
} from './tenant-context.port.js';

export class TenantContextRequiredError extends Error {
  constructor() {
    super('Tenant context is not available for this request');
    this.name = 'TenantContextRequiredError';
  }
}

export class InvalidTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantContextError';
  }
}

/**
 * Async request-context storage for the validated tenant subject. The service
 * itself is a singleton so repositories can depend on it without becoming
 * request-scoped; AsyncLocalStorage keeps concurrent requests isolated.
 *
 * The session contains only a tenant selector. This store contains the
 * membership-validated context used by application services, so a caller
 * cannot manufacture authorization by mutating a request field or session
 * selector after authentication.
 */
@Injectable()
export class TenantContextStore implements TenantContextPort {
  private readonly storage = new AsyncLocalStorage<TenantContext | null>();

  current(): TenantContext | null {
    return this.storage.getStore() ?? null;
  }

  require(): TenantContext {
    const context = this.current();
    if (context === null) {
      throw new TenantContextRequiredError();
    }

    return context;
  }

  set(context: TenantContext): void {
    if (!context.tenantId.trim()) {
      throw new InvalidTenantContextError('Tenant context requires a tenant');
    }

    if (!context.userId.trim()) {
      throw new InvalidTenantContextError('Tenant context requires a user');
    }

    this.storage.enterWith(Object.freeze({ ...context }));
  }

  clear(): void {
    this.storage.enterWith(null);
  }
}
