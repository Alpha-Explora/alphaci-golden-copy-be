import { BadRequestException } from '@nestjs/common';

import { DeploymentPolicyViolation } from '../domain/deployment-target.policy';
import type { CreateDeploymentTargetDto } from '../api/dto/create-deployment-target.dto';
import {
  buildCreateTargetTokenInput,
  mapSlotViolation,
} from './create-deployment-target.steps';

function tokenDto(
  overrides: Partial<CreateDeploymentTargetDto> = {},
): CreateDeploymentTargetDto {
  return {
    action: 'create',
    slot: 'backend',
    ownershipMode: 'byo',
    provider: 'render',
    ...overrides,
  };
}

describe('create-deployment-target.steps', () => {
  describe('mapSlotViolation', () => {
    it('converts DeploymentPolicyViolation to BadRequestException with policyError.message', () => {
      expect(() =>
        mapSlotViolation(
          new DeploymentPolicyViolation({
            code: 'provider_slot_not_supported',
            message: 'backend-only',
          }),
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        mapSlotViolation(
          new DeploymentPolicyViolation({
            code: 'provider_slot_not_supported',
            message: 'backend-only',
          }),
        ),
      ).toThrow('backend-only');
    });

    it('rethrows a generic Error', () => {
      expect(() => mapSlotViolation(new Error('boom'))).toThrow('boom');
      expect(() => mapSlotViolation(new Error('boom'))).not.toThrow(
        BadRequestException,
      );
    });
  });

  describe('buildCreateTargetTokenInput', () => {
    it('omits providerConnectionId when it is absent', () => {
      expect(buildCreateTargetTokenInput(tokenDto())).toEqual({
        ownershipMode: 'byo',
      });
    });

    it('includes providerConnectionId when it is present', () => {
      expect(
        buildCreateTargetTokenInput(
          tokenDto({ providerConnectionId: 'connection-1' }),
        ),
      ).toEqual({
        ownershipMode: 'byo',
        providerConnectionId: 'connection-1',
      });
    });
  });
});
