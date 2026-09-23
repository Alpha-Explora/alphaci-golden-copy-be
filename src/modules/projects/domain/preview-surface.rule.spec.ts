import { resolvePreviewSurface } from './preview-surface.rule';

describe('resolvePreviewSurface', () => {
  it('shows logs for a backend target whose provider offers log retrieval', () => {
    expect(resolvePreviewSurface('backend', true)).toBe('logs');
  });

  it('keeps the page thumbnail for a backend target with no log capability', () => {
    expect(resolvePreviewSurface('backend', false)).toBe('page');
  });

  it('keeps the page thumbnail for a frontend target even when logs are available', () => {
    expect(resolvePreviewSurface('frontend', true)).toBe('page');
  });

  it('keeps the page thumbnail for a standalone target', () => {
    expect(resolvePreviewSurface('standalone', true)).toBe('page');
  });

  it('keeps the page thumbnail when the slot is unknown', () => {
    expect(resolvePreviewSurface(null, true)).toBe('page');
  });
});
