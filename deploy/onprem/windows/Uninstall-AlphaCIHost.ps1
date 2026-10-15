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
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $ports = @($config.Ports)
    if ($PSCmdlet.ShouldProcess($config.Distro, 'disable AlphaCI polling timers, preserving containers and data')) {
        & wsl.exe -d $config.Distro -u root -- systemctl disable --now alphaci-machine.timer alphaci-agent.timer 2>$null
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
        & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>$null | Out-Null
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
