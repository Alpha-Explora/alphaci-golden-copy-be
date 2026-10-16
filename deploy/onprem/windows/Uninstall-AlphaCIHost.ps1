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
        # run in progress, so it cannot start one after the tunnels stop. Each
        # timer is disabled on its own: a host may have only one of them.
        $distro = $config.Distro
        $code = Invoke-Native { & wsl.exe -d $distro -u root -- systemctl disable --now alphaci-machine.timer }
        if ($code -ne 0) { Write-Warning "Could not disable alphaci-machine.timer in WSL (exit $code)." }
        $code = Invoke-Native { & wsl.exe -d $distro -u root -- systemctl disable --now alphaci-agent.timer }
        if ($code -ne 0) { Write-Warning "Could not disable alphaci-agent.timer in WSL (exit $code). It may not be installed." }
        $code = Invoke-Native { & wsl.exe -d $distro -u root -- systemctl stop alphaci-machine.service }
        if ($code -ne 0) { Write-Warning "Could not stop alphaci-machine.service in WSL (exit $code)." }
        # test -f exits 1 when the file is absent. Any other code means WSL itself failed.
        # Hosts whose agent predates tunnels have no tunnel.sh, so there is nothing to stop.
        $present = Invoke-Native { & wsl.exe -d $distro -u root -- test -f /opt/alphaci/bin/tunnel.sh }
        if ($present -eq 0) {
            $code = Invoke-Native { & wsl.exe -d $distro -u root -- /opt/alphaci/bin/alphaci-supervisor --stop-tunnels }
            if ($code -ne 0) {
                Write-Warning 'The automatic-address tunnels could not be stopped. In WSL, run: sudo /opt/alphaci/bin/alphaci-supervisor --stop-tunnels'
            }
        }
        elseif ($present -ne 1) {
            Write-Warning "Could not check WSL for the tunnel program (exit $present), so the automatic-address tunnels may still be running. In WSL, run: sudo /opt/alphaci/bin/alphaci-supervisor --stop-tunnels"
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
