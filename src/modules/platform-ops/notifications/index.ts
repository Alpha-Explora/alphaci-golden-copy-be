/**
 * Notifications — public API.
 *
 * This file is the module's entire surface. Everything under api/, application/ and
 * infrastructure/ is private, and `.dependency-cruiser.cjs` fails the build if another
 * module reaches past this file.
 *
 * Exporting something here is a deliberate commitment: it becomes a contract
 * other modules depend on, so add to this list only when a second module
 * genuinely needs it.
 *
 * Deliberately NOT exported:
 *   NotificationsRepository — storage is an implementation detail. If another
 *     module needs notification data, it asks NotificationsService for it, so
 *     this module stays free to change how it stores things.
 *   NotificationsController — HTTP is an entry point, never a dependency.
 */

export { NotificationsModule } from './notifications.module';

// Behaviour: how other features raise a notification. Four call sites today —
// projects, project-drift-repair, deployment-targets and env-vars.
export { NotificationEventsService } from './application/notification-events.service';

// Reads: used by consumers that render or summarise notifications.
export { NotificationsService } from './application/notifications.service';

// Contracts: the shapes crossing this boundary.
export type {
  NotificationPreferences,
  NotificationsResponse,
} from './notifications.types';
export type {
  NotificationContract,
  NotificationSeverityContract,
} from './contracts/notification.contract';
