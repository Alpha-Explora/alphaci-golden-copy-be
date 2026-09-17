import { parseClientPolicyDocument } from './client-policy.js';

const validDocument = {
  clientId: 'northwind',
  displayName: 'Northwind Industries',
  edition: 'enterprise',
  disabledCapabilities: ['runtime.preview-deployments'],
};

describe('Enterprise client policy document parser', () => {
  it('keeps the deny-only document contract', () => {
    expect(parseClientPolicyDocument(validDocument, 'test')).toEqual({
      clientId: 'northwind',
      displayName: 'Northwind Industries',
      edition: 'enterprise',
      disabledCapabilities: ['runtime.preview-deployments'],
    });
  });

  it('rejects fields that could widen a capability set', () => {
    expect(() =>
      parseClientPolicyDocument(
        { ...validDocument, enabledCapabilities: ['identity.sso-scim'] },
        'test',
      ),
    ).toThrow(/may only remove capabilities/);
  });
});
