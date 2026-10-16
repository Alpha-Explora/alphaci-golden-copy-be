import {
  effectivePublicAddress,
  ingressReadiness,
  tunnelPort,
  tunnelReport,
  WAITING_FOR_TUNNEL,
} from './onprem-tunnel';

const URL = 'https://quiet-fox-blue-cloud.trycloudflare.com';
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

describe('effectivePublicAddress', () => {
  const running = tunnelReport({
    status: 'running',
    url: URL,
    message: null,
    ...fresh,
  });
  it('uses the reported tunnel address only in tunnel mode', () => {
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
});

describe('tunnelPort', () => {
  it('serves the frontend, else the first slot', () => {
    expect(
      tunnelPort([
        { slot: 'backend', hostPort: 8081 },
        { slot: 'frontend', hostPort: 8080 },
      ]),
    ).toBe(8080);
    expect(tunnelPort([{ slot: 'backend', hostPort: 8081 }])).toBe(8081);
    expect(tunnelPort([])).toBeNull();
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
    ).toMatchObject({
      status: 'unverified',
    });
  });
  it('shows the machine reason until then', () => {
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
      message: 'cloudflared is not installed.',
    });
    expect(
      ingressReadiness({ mode: 'tunnel', publicUrl: null }, null, false),
    ).toEqual({
      status: 'failed',
      message: WAITING_FOR_TUNNEL,
    });
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
    ).toMatchObject({
      status: 'failed',
    });
  });
});
