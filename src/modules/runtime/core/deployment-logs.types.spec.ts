import { clampLogLimit, normalizeLogLevel } from './deployment-logs.types';

describe('normalizeLogLevel', () => {
  it.each([
    ['error', 'error'],
    ['fatal', 'error'],
    ['critical', 'error'],
    ['ERROR', 'error'],
    ['warn', 'warn'],
    ['warning', 'warn'],
    ['Warning', 'warn'],
    ['debug', 'debug'],
    ['trace', 'debug'],
    ['info', 'info'],
    ['system', 'info'],
    ['', 'info'],
    [undefined, 'info'],
    [null, 'info'],
  ])('maps %p to %p', (input, expected) => {
    expect(normalizeLogLevel(input)).toBe(expected);
  });
});

describe('clampLogLimit', () => {
  it('defaults to 100 when no limit is given', () => {
    expect(clampLogLimit(undefined)).toBe(100);
  });

  it('defaults to a caller-supplied fallback', () => {
    expect(clampLogLimit(undefined, 20)).toBe(20);
  });

  it('clamps below 1 up to 1', () => {
    expect(clampLogLimit(0)).toBe(1);
    expect(clampLogLimit(-5)).toBe(1);
  });

  it('clamps above 100 down to 100', () => {
    expect(clampLogLimit(500)).toBe(100);
  });

  it('truncates a fractional value', () => {
    expect(clampLogLimit(42.9)).toBe(42);
  });

  it('passes through a value already in range', () => {
    expect(clampLogLimit(33)).toBe(33);
  });
});
