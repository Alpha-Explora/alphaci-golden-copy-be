import type { DeploymentSlot } from '#kernel/ports/deployment-runtime.port';

/**
 * What the Production Deployment card shows for one branch preview.
 *
 * 'logs' is a live-tailed log view; every other target keeps the existing
 * framed page thumbnail. Scope v1 is deliberately narrow: only a `backend`
 * slot whose provider actually offers log retrieval gets the log surface, so
 * a frontend/standalone target - or a backend one on a provider with no log
 * capability - falls back to 'page' rather than showing a broken panel.
 */
export type PreviewSurface = 'page' | 'logs';

/**
 * A plain function, not an injectable class: undecorated classes in
 * runtime/domain get no constructor args from Nest (they need useFactory
 * wiring to see anything), and this rule has no dependencies to wire - it is
 * pure data in, data out, so a function keeps it that way.
 */
export function resolvePreviewSurface(
  slot: DeploymentSlot | null,
  logsAvailable: boolean,
): PreviewSurface {
  return slot === 'backend' && logsAvailable ? 'logs' : 'page';
}
