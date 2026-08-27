/**
 * Compatibility types for the historical Render-shaped deployment target
 * columns. They live separately from provider contracts so the shared
 * deployment DTOs and provider interfaces do not form a dependency cycle.
 */
export type RenderServiceType =
  'web_service' | 'private_service' | 'background_worker' | 'cron_job';
