<#
.SYNOPSIS
Runs one side of the AlphaCI host at Windows startup. Installed by Install-AlphaCIHost.ps1.

.DESCRIPTION
-Role Keepalive runs as the service account that owns the WSL distro. It starts
the distro, records its current address, and keeps it running so WSL never
stops it for being idle. If the distro stops, it starts it again. While the
distro runs it copies the host ports of the environments assigned to this
machine (published by the agent) to assigned-ports.json.

-Role PortForward runs as SYSTEM every minute. It reconciles one netsh portproxy
rule and one firewall rule per wanted port: the static -Ports from host.json plus
the assigned ports. It changes nothing when a rule is already right, and removes
the forwards and rules it owns for ports no longer wanted. WSL's NAT address
changes whenever the distro restarts.

Dot-source with -Role Library to load the functions without running a role.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Keepalive', 'PortForward', 'Library')]
    [string] $Role,
    [string] $ConfigPath = (Join-Path $env:ProgramData 'AlphaCI\host.json')
)

$ErrorActionPreference = 'Stop'
$ipv4 = '^(\d{1,3}\.){3}\d{1,3}$'
$publishedPortsPath = '/opt/alphaci/published-ports.json'

function ConvertTo-PortList([object[]] $Values) {
    # Windows PowerShell's ConvertFrom-Json returns a JSON array as one item; flatten it.
    $ports = foreach ($value in @($Values | ForEach-Object { $_ })) {
        $port = 0
        if ([int]::TryParse([string] $value, [ref] $port) -and $port -ge 1 -and $port -le 65535) { $port }
    }
    return @($ports | Sort-Object -Unique)
}

function Get-PortForwardPlan {
    param(
        [int[]] $Wanted,
        [hashtable] $Current,
        [int[]] $Owned,
        [string] $Address
    )
    $wantedSet = ConvertTo-PortList $Wanted
    $add = @($wantedSet | Where-Object { $Current[$_] -ne ($Address + ':' + $_) })
    # Only ports this host forwarded before, or that point at the distro, are ours to remove.
    $ours = @($Owned) + @($Current.Keys | Where-Object { $Current[$_] -like ($Address + ':*') })
    $remove = @(ConvertTo-PortList $ours | Where-Object { $wantedSet -notcontains $_ })
    return [pscustomobject]@{ Wanted = $wantedSet; Add = $add; Remove = $remove }
}

function Write-HostLog([string] $Message) {
    $line = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') + ' ' + $Message
    # Logging is not a change -WhatIf previews, so it always happens.
    Add-Content -LiteralPath $logFile -Value $line -WhatIf:$false
    # Keep the log small: the last 2000 lines.
    $lines = @(Get-Content -LiteralPath $logFile)
    if ($lines.Count -gt 2500) { $lines[-2000..-1] | Set-Content -LiteralPath $logFile -WhatIf:$false }
}

function Read-PortFile([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    try { return ConvertTo-PortList @(Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json) } catch { return @() }
}

function Write-PortFile([string] $Path, [int[]] $Ports) {
    $temporary = $Path + '.tmp'
    $json = '[' + (@($Ports | Where-Object { $null -ne $_ }) -join ',') + ']'
    Set-Content -LiteralPath $temporary -Value $json -WhatIf:$false
    Move-Item -Force -LiteralPath $temporary -Destination $Path -WhatIf:$false
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

function Update-AssignedPorts {
    $raw = (& wsl.exe -d $config.Distro -u root -- cat $publishedPortsPath 2>$null) -join ''
    # An agent that has not published yet keeps the last known list.
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return }
    try { $ports = ConvertTo-PortList @($raw | ConvertFrom-Json) } catch { return }
    if ((@(Read-PortFile $assignedFile) -join ',') -eq ($ports -join ',')) { return }
    Write-PortFile $assignedFile $ports
    Write-HostLog ('assigned ports: ' + ($(if ($ports.Count) { $ports -join ', ' } else { 'none' })))
}

function Invoke-Keepalive {
    while ($true) {
        $address = Get-WslAddress $config.Distro
        if ($address) {
            Set-Content -LiteralPath $addressFile -Value $address
            Write-HostLog ('distro ' + $config.Distro + ' running at ' + $address)
            $sleeper = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $config.Distro, '-u', 'root', '--', 'sleep', 'infinity') -WindowStyle Hidden -PassThru
            # The sleeper exits only when the distro stops.
            do { Update-AssignedPorts } until ($sleeper.WaitForExit(30000))
            Write-HostLog ('distro ' + $config.Distro + ' stopped; starting it again')
        } else {
            Write-HostLog ('distro ' + $config.Distro + ' has no IPv4 address yet')
        }
        Start-Sleep -Seconds 5
    }
}

function Sync-FirewallRules([int[]] $Wanted) {
    $existing = @{}
    foreach ($rule in @(Get-NetFirewallRule -Name 'AlphaCI TCP *' -ErrorAction SilentlyContinue)) { $existing[$rule.Name] = $rule }
    foreach ($port in $Wanted) {
        $name = 'AlphaCI TCP ' + $port
        if ($existing.ContainsKey($name)) { continue }
        if ($PSCmdlet.ShouldProcess($name, 'allow inbound from ' + ($config.ClientSubnets -join ', '))) {
            $rule = @{
                Name          = $name
                DisplayName   = $name
                Direction     = 'Inbound'
                Protocol      = 'TCP'
                LocalPort     = $port
                RemoteAddress = @($config.ClientSubnets)
                Action        = 'Allow'
                Profile       = 'Any'
            }
            New-NetFirewallRule @rule | Out-Null
            Write-HostLog ('firewall rule added for port ' + $port)
        }
    }
    foreach ($name in $existing.Keys) {
        if ($name -match '^AlphaCI TCP (\d+)$' -and $Wanted -notcontains [int] $Matches[1] -and $PSCmdlet.ShouldProcess($name, 'remove firewall rule')) {
            Remove-NetFirewallRule -Name $name
            Write-HostLog ('firewall rule removed for port ' + $Matches[1])
        }
    }
}

function Invoke-PortForward {
    if (-not (Test-Path -LiteralPath $addressFile)) { return }
    $address = (Get-Content -LiteralPath $addressFile -TotalCount 1).Trim()
    if ($address -notmatch $ipv4) {
        Write-HostLog ("ignoring invalid WSL address '" + $address + "'")
        return
    }
    $wanted = ConvertTo-PortList (@($config.Ports) + @(Read-PortFile $assignedFile))
    $plan = Get-PortForwardPlan -Wanted $wanted -Current (Get-PortProxyTargets) -Owned (Read-PortFile $forwardedFile) -Address $address
    foreach ($port in $plan.Add) {
        $target = $address + ':' + $port
        if ($PSCmdlet.ShouldProcess('0.0.0.0:' + $port, 'forward to ' + $target)) {
            & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null
            & netsh.exe interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$address | Out-Null
            Write-HostLog ('port ' + $port + ' now forwards to ' + $target)
        }
    }
    foreach ($port in $plan.Remove) {
        if ($PSCmdlet.ShouldProcess('0.0.0.0:' + $port, 'remove port forward')) {
            & netsh.exe interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 | Out-Null
            Write-HostLog ('port ' + $port + ' is no longer assigned; forward removed')
        }
    }
    if ($config.ClientSubnets) { Sync-FirewallRules $plan.Wanted }
    if (-not $WhatIfPreference) { Write-PortFile $forwardedFile $plan.Wanted }
}

if ($Role -eq 'Library') { return }
$root = Split-Path -Parent $ConfigPath
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$addressFile = Join-Path $root 'wsl-address.txt'
$assignedFile = Join-Path $root 'assigned-ports.json'
$forwardedFile = Join-Path $root 'forwarded-ports.json'
$logFile = Join-Path $root ('logs\' + $Role.ToLowerInvariant() + '.log')
if ($Role -eq 'Keepalive') { Invoke-Keepalive } else { Invoke-PortForward }
