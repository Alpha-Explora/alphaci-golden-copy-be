import { readCreatedService, readServiceStatus } from './render-env.mapping';

describe('readCreatedService', () => {
  it.each([
    {
      name: 'nested service id/name and serviceDetails.url',
      payload: {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested.onrender.com',
      },
    },
    {
      name: 'nested service details.url',
      payload: {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          details: { url: 'https://nested-details.onrender.com' },
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested-details.onrender.com',
      },
    },
    {
      name: 'nested service.url',
      payload: {
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          url: 'https://nested-url.onrender.com',
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested-url.onrender.com',
      },
    },
    {
      name: 'flat id/name/url',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
      },
      expected: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
      },
    },
    {
      name: 'flat serviceDetails.url',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        serviceDetails: { url: 'https://flat-sd.onrender.com' },
      },
      expected: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat-sd.onrender.com',
      },
    },
    {
      name: 'flat details.url',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        details: { url: 'https://flat-details.onrender.com' },
      },
      expected: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat-details.onrender.com',
      },
    },
    {
      name: 'nested id/name preferred over flat id/name',
      payload: {
        id: 'srv-flat',
        name: 'flat-name',
        url: 'https://flat.onrender.com',
        service: {
          id: 'srv-nested',
          name: 'nested-name',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      expected: {
        id: 'srv-nested',
        name: 'nested-name',
        url: 'https://nested.onrender.com',
      },
    },
    {
      name: 'missing url as null',
      payload: { id: 'srv-1', name: 'api' },
      expected: { id: 'srv-1', name: 'api', url: null },
    },
  ])('reads $name', ({ payload, expected }) => {
    expect(readCreatedService(payload)).toEqual(expected);
  });

  it('returns null when id or name is missing', () => {
    expect(readCreatedService({ service: {} })).toBeNull();
    expect(readCreatedService({ id: 'srv-1' })).toBeNull();
    expect(readCreatedService({ name: 'only-name' })).toBeNull();
  });
});

describe('readServiceStatus', () => {
  it.each([
    {
      name: 'nested url/suspended/ownerId',
      payload: {
        service: {
          suspended: 'not_suspended',
          ownerId: 'tea-nested',
          serviceDetails: { url: 'https://nested.onrender.com' },
        },
      },
      expected: {
        url: 'https://nested.onrender.com',
        state: 'not_suspended',
        ownerId: 'tea-nested',
      },
    },
    {
      name: 'flat url/suspended/ownerId',
      payload: {
        suspended: 'suspended',
        ownerId: 'tea-flat',
        url: 'https://flat.onrender.com',
      },
      expected: {
        url: 'https://flat.onrender.com',
        state: 'suspended',
        ownerId: 'tea-flat',
      },
    },
    {
      name: 'nested details.url without owner or state',
      payload: {
        service: { details: { url: 'https://nested-details.onrender.com' } },
      },
      expected: { url: 'https://nested-details.onrender.com' },
    },
  ])('reads $name', ({ payload, expected }) => {
    expect(readServiceStatus(payload)).toEqual(expected);
  });
});
