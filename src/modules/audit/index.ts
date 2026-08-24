/**
 * Audit — public API.
 *
 * Partial, like env-provisioning/index.ts: the existing deep imports into this
 * module are grandfathered in the dependency-cruiser baseline and this barrel
 * grows migrate-on-touch, so the baseline shrinks rather than grows.
 */

// Behaviour: how a feature records an auditable project event.
export { AuditEventsService } from './audit-events.service';
export { AuditModule } from './audit.module';
