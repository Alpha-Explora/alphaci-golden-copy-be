<#
.SYNOPSIS
Runs one side of the AlphaCI host at Windows startup. Installed by Install-AlphaCIHost.ps1.

.DESCRIPTION
-Role Keepalive runs as the service account that owns the WSL distro. It starts
the distro, records its current address, and blocks while the distro runs so
WSL never stops it for being idle. If the distro stops, it starts it again.

-Role PortForward runs as SYSTEM every minute. It points a netsh portproxy rule
for each published port at the recorded address, changing nothing when the rule
is already right. WSL's NAT address changes whenever the distro restarts.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Keepalive', 'PortForward')]
    [string] $Role,
    [string] $ConfigPath = (Join-Path $env:ProgramData 'AlphaCI\host.json')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $ConfigPath
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$addressFile = Join-Path $root 'wsl-address.txt'
$logFile = Join-Path $root ('logs\' + $Role.ToLowerInvariant() + '.log')
$ipv4 = '^(\d{1,3}\.){3}\d{1,3}$'

function Write-HostLog([string] $Message) {
    $line = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' ' + $Message
    # Logging is not a change -WhatIf previews, so it always happens.
    Add-Content -LiteralPath $logFile -Value $line -WhatIf:$false
    # Keep the log small: the last 2000 lines.
    $lines = @(Get-Content -LiteralPath $logFile)
    if ($lines.Count -gt 2500) { $lines[-2000..-1] | Set-Content -LiteralPath $logFile -WhatIf:$false }
}

function Get-WslAddress([string] $Distro) {
    $output = & wsl.exe -d $Distro -u root -- hostname -I 2>$null
    foreach ($candidate in (($output -join ' ') -split '\s+')) {
        if ($candidate -match $ipv4) { return $candidate }
    }
    return $null
}

function Get-PortProxyTargets {
    $targets = @{}
    foreach ($line in (& netsh.exe interface portproxy show v4tov4)) {
        if ($line -match '^\s*0\.0\.0\.0\s+(\d+)\s+(\S+)\s+(\d+)\s*$') {
            $targets[[int] $Matches[1]] = $Matches[2] + ':' + $Matches[3]
        }
    }
    return $targets
}

function Invoke-Keepalive {
    while ($true) {
        $address = Get-WslAddress $config.Distro
        if ($address) {
            Set-Content -LiteralPath $addressFile -Value $address
            Write-HostLog ('distro ' + $config.Distro + ' running at ' + $address)
            # Returns only when the distro stops.
            & wsl.exe -d $config.Distro -u root -- sleep infinity
            Write-HostLog ('distro ' + $config.Distro + ' stopped; starting it again')
        } else {
            Write-HostLog ('distro ' + $config.Distro + ' has no IPv4 address yet')
        }
        Start-Sleep -Seconds 5
    }
}

function Invoke-PortForward {
    if (-not (Test-Path -LiteralPath $addressFile)) { return }
    $address = (Get-Content -LiteralPath $addressFile -TotalCount 1).Trim()
    if ($address -notmatch $ipv4) {
        Write-HostLog ("ignoring invalid WSL address '" + $address + "'")
        return
    }
    $current = Get-PortProxyTargets
    foreach ($port in $config.Ports) {
        $wanted = $address + ':' + $port
        if ($current[[int] $port] -eq $wanted) { continue }
        if ($PSCmdlet.ShouldProcess('0.0.0.0:' + $port, 'forward to ' + $wanted)) {
            & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null
            & netsh.exe interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$address | Out-Null
            Write-HostLog ('port ' + $port + ' now forwards to ' + $wanted)
        }
    }
}

if ($Role -eq 'Keepalive') { Invoke-Keepalive } else { Invoke-PortForward }
