import { ShortTtlCoalescer } from './short-ttl-coalescer';

describe('ShortTtlCoalescer', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const coalescer = new ShortTtlCoalescer<number>();
    const load = jest.fn().mockResolvedValue(7);

    const results = await Promise.all([
      coalescer.run('k', 0, load),
      coalescer.run('k', 0, load),
      coalescer.run('k', 0, load),
    ]);

    expect(results).toEqual([7, 7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves a settled value until the ttl expires, then reloads', async () => {
    const coalescer = new ShortTtlCoalescer<number>();
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await expect(coalescer.run('k', 1_000, load)).resolves.toBe(1);
    jest.setSystemTime(999);
    await expect(coalescer.run('k', 1_000, load)).resolves.toBe(1);
    jest.setSystemTime(1_000);
    await expect(coalescer.run('k', 1_000, load)).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache with ttl 0 once the load settled', async () => {
    const coalescer = new ShortTtlCoalescer<number>();
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await coalescer.run('k', 0, load);
    await expect(coalescer.run('k', 0, load)).resolves.toBe(2);
  });

  it('never caches a failure and keeps keys separate', async () => {
    const coalescer = new ShortTtlCoalescer<number>();
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(3);

    await expect(coalescer.run('k', 1_000, load)).rejects.toThrow('boom');
    await expect(coalescer.run('k', 1_000, load)).resolves.toBe(3);
    await expect(
      coalescer.run('other', 1_000, () => Promise.resolve(9)),
    ).resolves.toBe(9);
  });
});
