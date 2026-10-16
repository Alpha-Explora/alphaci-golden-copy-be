#Requires -RunAsAdministrator
<#
.SYNOPSIS
Removes the AlphaCI scheduled tasks, port forwards, and firewall rules. Leaves the WSL distro and its data alone.

.DESCRIPTION
Take and verify an application data backup first. Removing the distro itself
(wsl --unregister) deletes all of its data and needs the client's written approval.
#>
[CmdletBinding(SupportsShouldProcess)]
param([switch] $RemoveLogs)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'AlphaCI'
$configPath = Join-Path $root 'host.json'
$ports = @()

# Native commands write to stderr. Windows PowerShell 5.1 turns that stderr into
# a terminating error under 'Stop', so each native call runs with 'Continue' and
# reports only its exit code. A failed step must not stop the rest of the uninstall.
function Invoke-Native {
    param([scriptblock] $Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Command *> $null
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $ports = @($config.Ports)
    if ($PSCmdlet.ShouldProcess($config.Distro, 'stop AlphaCI tunnels and polling timers, preserving containers and data')) {
        # Disable polling first, so no run can start a tunnel again. Then stop a
        # run in progress, so it cannot start one after the tunnels stop. Hosts
        # whose agent predates tunnels skip the last step: their supervisor does
        # not know the flag and would run a full poll instead.
        $distro = $config.Distro
        [void](Invoke-Native { & wsl.exe -d $distro -u root -- systemctl disable --now alphaci-machine.timer alphaci-agent.timer })
        [void](Invoke-Native { & wsl.exe -d $distro -u root -- systemctl stop alphaci-machine.service })
        if ((Invoke-Native { & wsl.exe -d $distro -u root -- test -f /opt/alphaci/bin/tunnel.sh }) -eq 0) {
            if ((Invoke-Native { & wsl.exe -d $distro -u root -- /opt/alphaci/bin/alphaci-supervisor --stop-tunnels }) -ne 0) {
                Write-Warning 'The automatic-address tunnels could not be stopped. In WSL, run: sudo /opt/alphaci/bin/alphaci-supervisor --stop-tunnels'
            }
        }
    }
}

foreach ($task in 'AlphaCI Host', 'AlphaCI Port Forward') {
    $registered = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($registered -and $PSCmdlet.ShouldProcess($task, 'unregister')) {
        Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $task -Confirm:$false
    }
}
$forwardedPath = Join-Path $root 'forwarded-ports.json'
if (Test-Path -LiteralPath $forwardedPath) {
    # Assigned ports the port forward task added; ConvertFrom-Json may return one array item.
    $ports += @(Get-Content -Raw -LiteralPath $forwardedPath | ConvertFrom-Json | ForEach-Object { $_ })
}
foreach ($port in ($ports | Sort-Object -Unique)) {
    if ($PSCmdlet.ShouldProcess('0.0.0.0:' + $port, 'remove port forward')) {
        [void](Invoke-Native { & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 })
    }
}
Get-NetFirewallRule -Name 'AlphaCI TCP *' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($PSCmdlet.ShouldProcess($_.Name, 'remove firewall rule')) { Remove-NetFirewallRule -Name $_.Name }
}
if ($RemoveLogs -and (Test-Path -LiteralPath $root) -and $PSCmdlet.ShouldProcess($root, 'remove')) {
    if ([IO.Path]::GetFullPath($root) -ne [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'AlphaCI'))) { throw 'Unexpected uninstall target.' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output 'AlphaCI host tasks, port forwards, and firewall rules removed. The WSL distro is unchanged.'
