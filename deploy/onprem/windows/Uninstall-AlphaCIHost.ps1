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
    $ports = @((Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).Ports)
}

foreach ($task in 'AlphaCI Host', 'AlphaCI Port Forward') {
    $registered = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($registered -and $PSCmdlet.ShouldProcess($task, 'unregister')) {
        Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $task -Confirm:$false
    }
}
foreach ($port in $ports) {
    if ($PSCmdlet.ShouldProcess('0.0.0.0:' + $port, 'remove port forward')) {
        & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>$null | Out-Null
    }
}
Get-NetFirewallRule -Name 'AlphaCI TCP *' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($PSCmdlet.ShouldProcess($_.Name, 'remove firewall rule')) { Remove-NetFirewallRule -Name $_.Name }
}
if ($RemoveLogs -and (Test-Path -LiteralPath $root) -and $PSCmdlet.ShouldProcess($root, 'remove')) {
    Remove-Item -LiteralPath $root -Recurse -Force
}
Write-Output 'AlphaCI host tasks, port forwards, and firewall rules removed. The WSL distro is unchanged.'
