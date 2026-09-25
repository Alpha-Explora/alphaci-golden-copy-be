import { resolveVerifyWorkflowFile } from './resolve-verify-workflow-file';

describe('resolveVerifyWorkflowFile', () => {
  it('applies no suffix for a single-repo project', () => {
    expect(
      resolveVerifyWorkflowFile('.github/workflows/00-alphaci-access.yml'),
    ).toBe('30-alphaci-verify.yml');
  });

  it('carries the backend variant suffix from a microservices bundle', () => {
    expect(
      resolveVerifyWorkflowFile(
        '.github/workflows/00-alphaci-access-backend.yml',
      ),
    ).toBe('30-alphaci-verify-backend.yml');
  });

  it('carries the frontend variant suffix', () => {
    expect(
      resolveVerifyWorkflowFile(
        '.github/workflows/00-alphaci-access-frontend.yml',
      ),
    ).toBe('30-alphaci-verify-frontend.yml');
  });

  it('falls back to no suffix for a BYO/existing-repo workflow path', () => {
    expect(resolveVerifyWorkflowFile('.github/workflows/ci.yml')).toBe(
      '30-alphaci-verify.yml',
    );
  });

  it('falls back to no suffix for a null workflow_path', () => {
    expect(resolveVerifyWorkflowFile(null)).toBe('30-alphaci-verify.yml');
  });

  it('falls back to no suffix for an undefined workflow_path', () => {
    expect(resolveVerifyWorkflowFile(undefined)).toBe('30-alphaci-verify.yml');
  });

  it('falls back to no suffix for an empty string', () => {
    expect(resolveVerifyWorkflowFile('')).toBe('30-alphaci-verify.yml');
  });
});
