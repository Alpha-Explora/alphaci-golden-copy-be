import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The PortForward task reconciles netsh and the firewall from the ports the
// agent publishes. netsh and the firewall cmdlets are replaced by recorders.
const script = resolve('deploy/onprem/windows/Start-AlphaCIHost.ps1');
// The scheduled tasks run Windows PowerShell 5.1; CI runners have pwsh.
const shells = ['pwsh', 'powershell'].filter(
  (shell) =>
    spawnSync(shell, ['-NoProfile', '-Command', 'exit 0']).status === 0,
);

function run(
  shell: string,
  body: string,
  config: object,
  files: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'alphaci-windows-'));
  writeFileSync(join(root, 'host.json'), JSON.stringify(config));
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(root, name), value);
  const command = `
$ErrorActionPreference = 'Stop'
$script:calls = [System.Collections.Generic.List[string]]::new()
$script:proxies = @()
$script:rules = @()
function netsh.exe { if ($args -contains 'show') { $script:proxies } else { $script:calls.Add('netsh ' + ($args -join ' ')) } }
function Get-NetFirewallRule { $script:rules | ForEach-Object { [pscustomobject]@{ Name = $_ } } }
function New-NetFirewallRule { param($Name, $DisplayName, $Direction, $Protocol, $LocalPort, $RemoteAddress, $Action, $Profile) $script:calls.Add('new ' + $Name + ' from ' + ($RemoteAddress -join ',')) }
function Remove-NetFirewallRule { param($Name) $script:calls.Add('remove ' + $Name) }
& {
  [CmdletBinding(SupportsShouldProcess)] param()
  . '${script}' -Role Library
  $root = '${root}'
  $config = Get-Content -Raw -LiteralPath (Join-Path $root 'host.json') | ConvertFrom-Json
  $addressFile = Join-Path $root 'wsl-address.txt'
  $assignedFile = Join-Path $root 'assigned-ports.json'
  $forwardedFile = Join-Path $root 'forwarded-ports.json'
  $logFile = Join-Path $root 'port.log'
  ${body}
}
$script:calls`;
  const output = execFileSync(
    shell,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8' },
  );
  return { root, calls: output.trim().split(/\r?\n/).filter(Boolean) };
}

const suite = shells.length
  ? describe.each(shells)
  : describe.skip.each(['none']);
suite('Windows host port forwarding (%s)', (shell) => {
  const powershell = (
    body: string,
    config: object,
    files: Record<string, string> = {},
  ) => run(shell, body, config, files);
  it('forwards every assigned port, not a fixed range, and opens it to the client subnets', () => {
    const { root, calls } = powershell(
      'Invoke-PortForward',
      { Distro: 'Ubuntu', Ports: [], ClientSubnets: ['LocalSubnet'] },
      {
        'wsl-address.txt': '172.20.0.5\n',
        'assigned-ports.json': '[8080, 8083, 9443]',
      },
    );
    for (const port of [8080, 8083, 9443]) {
      expect(calls).toContain(
        `netsh interface portproxy add v4tov4 listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=172.20.0.5`,
      );
      expect(calls).toContain(`new AlphaCI TCP ${port} from LocalSubnet`);
    }
    expect(
      JSON.parse(readFileSync(join(root, 'forwarded-ports.json'), 'utf8')),
    ).toEqual([8080, 8083, 9443]);
  });

  it('removes forwards and rules it owns once a port is unassigned, leaving others alone', () => {
    const { calls } = powershell(
      `$script:proxies = @('  0.0.0.0  8080  172.20.0.5  8080', '  0.0.0.0  8081  172.20.0.5  8081', '  0.0.0.0  3389  10.0.0.9  3389')
       $script:rules = @('AlphaCI TCP 8080', 'AlphaCI TCP 8081', 'Remote Desktop')
       Invoke-PortForward`,
      { Distro: 'Ubuntu', Ports: [443], ClientSubnets: ['10.20.0.0/16'] },
      {
        'wsl-address.txt': '172.20.0.5',
        'assigned-ports.json': '[8080]',
      },
    );
    expect(calls).toEqual([
      'netsh interface portproxy delete v4tov4 listenport=443 listenaddress=0.0.0.0',
      'netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=443 connectaddress=172.20.0.5',
      'netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=0.0.0.0',
      'new AlphaCI TCP 443 from 10.20.0.0/16',
      'remove AlphaCI TCP 8081',
    ]);
  });

  // A host whose agent has not published (or with no agent, like a self-hosted
  // AlphaCI server) gets stderr from wsl.exe. Windows PowerShell turns
  // redirected native stderr into an error, so 'Stop' ended the keepalive.
  it('keeps going when wsl.exe fails before the agent has published', () => {
    const { root, calls } = powershell(
      `function wsl.exe {
         if ($env:OS -eq 'Windows_NT') { cmd.exe /c 'echo cat: No such file or directory 1>&2 & exit /b 1' }
         else { sh -c 'echo "cat: No such file or directory" >&2; exit 1' }
       }
       Update-AssignedPorts
       'address=' + (Get-WslAddress 'Ubuntu')`,
      { Distro: 'Ubuntu', Ports: [] },
    );
    expect(calls).toEqual(['address=']);
    expect(existsSync(join(root, 'assigned-ports.json'))).toBe(false);
  });

  it('ignores invalid published ports', () => {
    const { calls } = powershell(
      '(ConvertTo-PortList @(8080, "x", 0, 70000, "8081", 8080)) -join ","',
      { Distro: 'Ubuntu', Ports: [] },
    );
    expect(calls).toEqual(['8080,8081']);
  });
});
