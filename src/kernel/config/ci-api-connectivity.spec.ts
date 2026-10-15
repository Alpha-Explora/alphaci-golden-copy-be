import { validateCiApiConnectivity } from './ci-api-connectivity';
import { runInNewContext } from 'node:vm';

describe('CI API connectivity preflight', () => {
  it.each([
    'http://localhost:4000',
    'https://127.1',
    'https://2130706433',
    'https://[::1]',
    'https://10.0.0.2',
    'https://172.16.2.3',
    'https://192.168.1.3',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://[::ffff:127.0.0.1]',
    'https://[fc00::1]',
    'https://api.local',
    'https://a:b@api.example.com',
    'http://api.example.com',
  ])('rejects %s for GitHub-hosted jobs', (url) => {
    expect(() => validateCiApiConnectivity(url, 'github-hosted')).toThrow();
  });
  it('allows public HTTPS and explicit private execution', () => {
    expect(() =>
      validateCiApiConnectivity(
        'https://api.example.com/api/v1',
        'github-hosted',
      ),
    ).not.toThrow();
    expect(() =>
      validateCiApiConnectivity('http://10.0.0.1:4000', 'private-network'),
    ).not.toThrow();
  });
  it('runs without module closures in the generated runner preflight', () => {
    const source = `const validate = ${validateCiApiConnectivity.toString()}; validate(url, 'github-hosted');`;
    expect(() => {
      runInNewContext(source, { URL, url: 'https://api.example.com' });
    }).not.toThrow();
    expect(() => {
      runInNewContext(source, { URL, url: 'http://localhost:4000' });
    }).toThrow('PLATFORM_PUBLIC_URL');
  });
});
