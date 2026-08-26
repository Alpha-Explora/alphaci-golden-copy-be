import { UnauthorizedException } from '@nestjs/common';

import { UsageController } from './usage.controller';

describe('UsageController', () => {
  const usageQuotaService = {
    getUsage: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    usageQuotaService.getUsage.mockResolvedValue({
      enabled: true,
      plan: 'free',
      items: [],
    });
  });

  it('returns usage for the session user', async () => {
    const controller = new UsageController(usageQuotaService as never);

    await expect(
      controller.getMyUsage({
        session: { user: { id: 'user-1' } },
      } as never),
    ).resolves.toMatchObject({ plan: 'free' });
    expect(usageQuotaService.getUsage).toHaveBeenCalledWith('user-1');
  });

  it('rejects unauthenticated usage requests', async () => {
    const controller = new UsageController(usageQuotaService as never);

    await expect(
      controller.getMyUsage({ session: {} } as never),
    ).rejects.toThrow(UnauthorizedException);
  });
});
