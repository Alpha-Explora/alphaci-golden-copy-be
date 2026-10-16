import {
  QUICK_TUNNEL_ADDRESS,
  REJECTED_TUNNEL_ADDRESS,
  RUNNING_WITHOUT_ADDRESS,
  UNKNOWN_TUNNEL_STATE,
  WAITING_FOR_TUNNEL,
  effectivePublicAddress,
  ingressReadiness,
  parseTunnelReport,
  servedSlot,
  tunnelPort,
  tunnelReady,
  tunnelReport,
} from './onprem-tunnel';

const URL = 'https://quiet-fox-blue-cloud.trycloudflare.com';
const ID = '3f2b1c4e-5d6a-4b7c-8d9e-0f1a2b3c4d5e';
const fresh = { reportedAt: new Date('2026-10-16T10:00:00Z'), fresh: true };

describe('tunnelReport', () => {
  it('shows waiting until a report is fresh', () => {
    expect(
      tunnelReport({
        status: null,
        url: null,
        message: null,
        reportedAt: null,
        fresh: false,
      }),
    ).toEqual({
      status: 'waiting',
      publicUrl: null,
      message: WAITING_FOR_TUNNEL,
      reportedAt: null,
    });
    expect(
      tunnelReport({
        status: 'running',
        url: URL,
        message: 'Ready.',
        ...fresh,
        fresh: false,
      }),
    ).toMatchObject({ status: 'waiting', publicUrl: null });
  });
  it('exposes the address only while the tunnel is running', () => {
    expect(
      tunnelReport({
        status: 'running',
        url: URL,
        message: 'Ready.',
        ...fresh,
      }),
    ).toEqual({
      status: 'running',
      publicUrl: URL,
      message: 'Ready.',
      reportedAt: '2026-10-16T10:00:00.000Z',
    });
    expect(
      tunnelReport({
        status: 'starting',
        url: null,
        message: 'Starting.',
        ...fresh,
      }),
    ).toMatchObject({
      status: 'starting',
      publicUrl: null,
      message: 'Starting.',
    });
  });
});

describe('QUICK_TUNNEL_ADDRESS', () => {
  it.each([
    URL,
    'https://favorites-vocal-message-subsidiaries.trycloudflare.com',
  ])('accepts the quick-tunnel address %s', (address) => {
    expect(QUICK_TUNNEL_ADDRESS.test(address)).toBe(true);
  });
  it.each([
    ['the API host', 'https://api.trycloudflare.com'],
    ['a single-word host', 'https://quiet.trycloudflare.com'],
    ['an IP address', 'https://203.0.113.7'],
    ['a non-quick-tunnel host', 'https://quiet-fox-blue.example.com'],
    ['plain HTTP', 'http://quiet-fox-blue-cloud.trycloudflare.com'],
    ['a path', 'https://quiet-fox-blue-cloud.trycloudflare.com/app'],
    ['credentials', 'https://user@quiet-fox-blue-cloud.trycloudflare.com'],
    [
      'a lookalike suffix',
      'https://quiet-fox-blue-cloud.trycloudflare.com.evil.example',
    ],
  ])('rejects %s', (_name, address) => {
    expect(QUICK_TUNNEL_ADDRESS.test(address)).toBe(false);
  });
});

describe('parseTunnelReport', () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    assignmentId: ID,
    status: 'running',
    message: 'Ready.',
    publicUrl: URL,
    ...overrides,
  });
  it('accepts a running tunnel with its quick-tunnel address', () => {
    expect(parseTunnelReport(report())).toEqual({
      assignmentId: ID,
      status: 'running',
      message: 'Ready.',
      publicUrl: URL,
    });
  });
  it('accepts a starting or failed tunnel without an address', () => {
    expect(
      parseTunnelReport(report({ status: 'starting', publicUrl: null })),
    ).toMatchObject({ status: 'starting', publicUrl: null });
    expect(
      parseTunnelReport(report({ status: 'failed', publicUrl: null })),
    ).toMatchObject({ status: 'failed', publicUrl: null });
  });
  it('drops an entry without a valid assignment ID', () => {
    expect(parseTunnelReport(report({ assignmentId: 'frontend' }))).toBeNull();
    expect(parseTunnelReport(null)).toBeNull();
    expect(parseTunnelReport('running')).toBeNull();
  });
  it('records an unacceptable address or state as failed, with the reason', () => {
    expect(
      parseTunnelReport(report({ publicUrl: 'https://api.trycloudflare.com' })),
    ).toEqual({
      assignmentId: ID,
      status: 'failed',
      message: REJECTED_TUNNEL_ADDRESS,
      publicUrl: null,
    });
    expect(parseTunnelReport(report({ publicUrl: 42 }))).toMatchObject({
      status: 'failed',
      message: REJECTED_TUNNEL_ADDRESS,
    });
    expect(parseTunnelReport(report({ status: 'stopped' }))).toMatchObject({
      status: 'failed',
      message: UNKNOWN_TUNNEL_STATE,
    });
    expect(parseTunnelReport(report({ publicUrl: null }))).toMatchObject({
      status: 'failed',
      message: RUNNING_WITHOUT_ADDRESS,
    });
    expect(parseTunnelReport(report({ status: 'starting' }))).toMatchObject({
      status: 'failed',
      message: REJECTED_TUNNEL_ADDRESS,
    });
  });
  it('keeps the message within 300 characters', () => {
    expect(
      parseTunnelReport(report({ message: 'x'.repeat(400) }))?.message,
    ).toHaveLength(300);
  });
});

describe('served slot and address', () => {
  it('serves the frontend, else the first slot', () => {
    const ports = [
      { slot: 'backend', hostPort: 8081 },
      { slot: 'frontend', hostPort: 8080 },
    ];
    expect(servedSlot(ports)).toBe('frontend');
    expect(tunnelPort(ports)).toBe(8080);
    expect(servedSlot([{ slot: 'backend', hostPort: 8081 }])).toBe('backend');
    expect(tunnelPort([{ slot: 'backend', hostPort: 8081 }])).toBe(8081);
    expect(tunnelPort([])).toBeNull();
  });
  it('uses the reported tunnel address only in tunnel mode', () => {
    const running = tunnelReport({
      status: 'running',
      url: URL,
      message: null,
      ...fresh,
    });
    expect(
      effectivePublicAddress({ mode: 'tunnel', publicUrl: null }, running),
    ).toBe(URL);
    expect(
      effectivePublicAddress({ mode: 'tunnel', publicUrl: null }, null),
    ).toBeNull();
    expect(
      effectivePublicAddress(
        { mode: 'configured', publicUrl: 'https://app.example.com' },
        running,
      ),
    ).toBe('https://app.example.com');
    expect(
      effectivePublicAddress({ mode: 'direct', publicUrl: null }, null),
    ).toBeNull();
  });
  it('is ready for production only with a fresh running address', () => {
    expect(
      tunnelReady({ status: 'running', url: URL, message: null, ...fresh }),
    ).toBe(true);
    expect(
      tunnelReady({
        status: 'running',
        url: URL,
        message: null,
        reportedAt: null,
        fresh: false,
      }),
    ).toBe(false);
    expect(
      tunnelReady({ status: 'starting', url: null, message: null, ...fresh }),
    ).toBe(false);
  });
});

describe('ingressReadiness', () => {
  const running = tunnelReport({
    status: 'running',
    url: URL,
    message: null,
    ...fresh,
  });
  it('passes the HTTPS requirement for production once an address is reported', () => {
    expect(
      ingressReadiness({ mode: 'tunnel', publicUrl: null }, running, true),
    ).toMatchObject({ status: 'unverified' });
  });
  it('waits for the HTTPS address in production, with the machine reason', () => {
    expect(
      ingressReadiness({ mode: 'tunnel', publicUrl: null }, null, true),
    ).toEqual({
      status: 'failed',
      message:
        'Waiting for the HTTPS address. Production is not deployed until the machine reports one.',
    });
    const unavailable = tunnelReport({
      status: 'unavailable',
      url: null,
      message: 'cloudflared is not installed.',
      ...fresh,
    });
    expect(
      ingressReadiness({ mode: 'tunnel', publicUrl: null }, unavailable, true),
    ).toEqual({
      status: 'failed',
      message: 'Waiting for the HTTPS address. cloudflared is not installed.',
    });
  });
  it('shows the machine reason for other environments', () => {
    expect(
      ingressReadiness({ mode: 'tunnel', publicUrl: null }, null, false),
    ).toEqual({ status: 'failed', message: WAITING_FOR_TUNNEL });
  });
  it('keeps production configured ingress to HTTPS URLs', () => {
    expect(
      ingressReadiness(
        { mode: 'configured', publicUrl: 'https://app.example.com' },
        null,
        true,
      ),
    ).toMatchObject({ status: 'unverified' });
    expect(
      ingressReadiness({ mode: 'direct', publicUrl: null }, null, true),
    ).toMatchObject({ status: 'failed' });
  });
});
