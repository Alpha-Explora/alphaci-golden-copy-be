import type { CompositionSubject } from './capability-resolver.port.js';
import type { CapabilityManifest } from './capability-types.js';

export const CAPABILITY_MANIFEST_SOURCE = Symbol('CapabilityManifestSource');

export interface CapabilityManifestSource {
  /** Deployment-wide manifest used for anonymous callers and boot checks. */
  deployment(): CapabilityManifest;
  /** Subject-scoped manifest, which may narrow the deployment manifest later. */
  for(subject: CompositionSubject): CapabilityManifest;
}
