/** Self-contained so the same preflight can run in generated GitHub jobs. */
export function validateCiApiConnectivity(
  baseUrl: string,
  execution: 'github-hosted' | 'private-network',
): void {
  const problem =
    'Configure PLATFORM_PUBLIC_URL with an HTTPS API address reachable from the GitHub runner. Localhost and private addresses cannot reach this laptop from GitHub-hosted jobs.';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(problem);
  }
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new Error(problem);
  if (execution === 'private-network') return;
  if (url.protocol !== 'https:') throw new Error(problem);
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host.includes(':')) {
    // IPv6 global unicast only; excludes mapped IPv4, loopback, ULA and link local.
    if (!/^[23][0-9a-f]{3}:/.test(host)) throw new Error(problem);
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    )
      throw new Error(problem);
  } else if (
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|lan)$/.test(host)
  ) {
    throw new Error(problem);
  }
}
