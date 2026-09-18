import {
  InvalidTenantContextError,
  TenantContextRequiredError,
  TenantContextStore,
} from './tenant-context.js';

describe('TenantContextStore', () => {
  const context = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    membershipRole: 'member' as const,
    deploymentMode: 'hosted' as const,
  };

  it('starts empty and fails closed when required', () => {
    const store = new TenantContextStore();

    expect(store.current()).toBeNull();
    expect(() => store.require()).toThrow(TenantContextRequiredError);
  });

  it('stores an immutable validated context and clears it', () => {
    const store = new TenantContextStore();

    store.set(context);

    expect(store.current()).toEqual(context);
    expect(() => {
      (store.current() as { tenantId: string }).tenantId = 'other';
    }).toThrow();

    store.clear();
    expect(store.current()).toBeNull();
  });

  it.each([
    ['tenantId', { ...context, tenantId: ' ' }],
    ['userId', { ...context, userId: '' }],
  ])('rejects an empty %s', (_field, invalidContext) => {
    const store = new TenantContextStore();

    expect(() => store.set(invalidContext)).toThrow(InvalidTenantContextError);
  });
});
