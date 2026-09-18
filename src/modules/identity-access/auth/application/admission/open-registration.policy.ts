import { Injectable } from '@nestjs/common';

import type {
  AdmissionPolicy,
  AdmissionPolicyResult,
  ResolvedProviderProfile,
} from './admission-policy.port.js';

/** The no-internal-org deployment path: admit without overwriting the flag. */
@Injectable()
export class OpenRegistrationAdmissionPolicy implements AdmissionPolicy {
  evaluate(
    profile: ResolvedProviderProfile,
    providerAccessToken: string,
  ): Promise<AdmissionPolicyResult> {
    void profile;
    void providerAccessToken;
    return Promise.resolve({ kind: 'admit', isInternal: null });
  }
}
