import { SetMetadata } from '@nestjs/common';

import type { CapabilityKey } from './capability-types.js';

export const REQUIRED_CAPABILITIES = Symbol('RequiredCapabilities');

export const RequiresCapability = (...keys: CapabilityKey[]) =>
  SetMetadata(REQUIRED_CAPABILITIES, keys);
