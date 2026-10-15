<#
.SYNOPSIS
Collects a support archive: the Windows side (tasks, port forwards, firewall, logs, WSL status)
plus the agent's own bundle from inside the distro. It holds no tokens or application secrets,
but it includes recent container logs, so review it before sending.
#>
[CmdletBinding()]
param([string] $OutputDirectory = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'AlphaCI'
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'host.json') | ConvertFrom-Json
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$work = Join-Path $env:TEMP ('alphaci-host-support-' + $stamp)
New-Item -ItemType Directory -Force -Path $work | Out-Null

& wsl.exe --version 2>&1 | Out-File (Join-Path $work 'wsl-version.txt')
& wsl.exe -l -v 2>&1 | Out-File (Join-Path $work 'wsl-distros.txt')
& netsh.exe interface portproxy show v4tov4 | Out-File (Join-Path $work 'portproxy.txt')
Get-ScheduledTask -TaskName 'AlphaCI *' | Get-ScheduledTaskInfo |
    Format-List TaskName, LastRunTime, LastTaskResult, NextRunTime | Out-File (Join-Path $work 'tasks.txt')
Get-NetFirewallRule -Name 'AlphaCI TCP *' -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
        Name    = $_.Name
        Enabled = $_.Enabled
        Remote  = (($_ | Get-NetFirewallAddressFilter).RemoteAddress -join ',')
        Port    = ($_ | Get-NetFirewallPortFilter).LocalPort
    }
} | Format-Table -AutoSize | Out-File (Join-Path $work 'firewall.txt')
Copy-Item -Recurse -LiteralPath (Join-Path $root 'logs') -Destination $work -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $root 'wsl-address.txt') -Destination $work -ErrorAction SilentlyContinue

# The agent writes its own archive inside the distro; copy it out as bytes.
$linuxBundle = & wsl.exe -d $config.Distro -u root -- bash -c 'if test -s /opt/alphaci/machine.json; then exec /opt/alphaci/bin/alphaci-supervisor support-bundle; else exec /opt/alphaci/bin/alphaci-agent support-bundle; fi' | Select-Object -Last 1
if ($linuxBundle) {
    $windowsPath = (& wsl.exe -d $config.Distro -u root -- wslpath -w $linuxBundle.Trim()) -join ''
    Copy-Item -LiteralPath $windowsPath.Trim() -Destination (Join-Path $work 'agent-support.tar.gz')
}

$archive = Join-Path $OutputDirectory ('alphaci-host-support-' + $stamp + '.zip')
Compress-Archive -Path (Join-Path $work '*') -DestinationPath $archive -Force
Remove-Item -LiteralPath $work -Recurse -Force
Write-Output $archive
