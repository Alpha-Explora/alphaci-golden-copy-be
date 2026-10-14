#Requires -RunAsAdministrator
<#
.SYNOPSIS
Prepares a Windows host so its WSL distro serves AlphaCI releases to the client network. Safe to rerun.

.DESCRIPTION
Run after the distro has Docker Engine, systemd, and the agent (deploy/onprem/agent/install.sh).
It installs two scheduled tasks and one firewall rule per port:

  AlphaCI Host          as the account that owns the distro, not elevated: keeps it running.
  AlphaCI Port Forward  as SYSTEM, at startup and every minute: keeps netsh portproxy
                        pointed at the distro's current address.
  AlphaCI TCP <port>    inbound, only from -ClientSubnets.

Rerunning updates all of them in place. Nothing inside the distro is changed.

.EXAMPLE
.\Install-AlphaCIHost.ps1 -Distro Ubuntu-24.04 -ServiceAccount CONTOSO\alphaci-svc -ClientSubnets 10.20.0.0/16
Client server: runs at startup whether or not anyone signs in; asks for the account's password.

.EXAMPLE
.\Install-AlphaCIHost.ps1 -Distro Ubuntu -ClientSubnets LocalSubnet -OnlyWhenSignedIn
Test laptop: runs as you when you sign in, so no password is stored.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Distro,
    [Parameter(Mandatory)] [string[]] $ClientSubnets,
    [int[]] $Ports = @(443),
    [string] $ServiceAccount = ($env:USERDOMAIN + '\' + $env:USERNAME),
    [switch] $OnlyWhenSignedIn
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'AlphaCI'
$startScript = Join-Path $root 'Start-AlphaCIHost.ps1'
$currentAccount = $env:USERDOMAIN + '\' + $env:USERNAME

New-Item -ItemType Directory -Force -Path $root, (Join-Path $root 'logs') | Out-Null
Copy-Item -Force -LiteralPath (Join-Path $PSScriptRoot 'Start-AlphaCIHost.ps1') -Destination $startScript
@{ Distro = $Distro; Ports = $Ports } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'host.json')
# The service account writes the distro address and its log here; SYSTEM reads them.
& icacls.exe $root /grant ($ServiceAccount + ':(OI)(CI)M') | Out-Null

# WSL distros belong to one Windows account, so the checks run only as that account.
if ($ServiceAccount -eq $currentAccount) {
    $distros = @((& wsl.exe -l -q) -replace [char]0, '' | Where-Object { $_.Trim() })
    if ($distros -notcontains $Distro) {
        throw ("WSL distro '" + $Distro + "' is not installed for " + $ServiceAccount + '. Installed: ' + ($distros -join ', '))
    }
    $systemd = (& wsl.exe -d $Distro -u root -- systemctl is-system-running 2>$null) -join ''
    if ($systemd -notmatch 'running|degraded') {
        throw ('systemd is not running in ' + $Distro + ' (' + $systemd + '). Set [boot] systemd=true in /etc/wsl.conf, then run wsl --shutdown.')
    }
}

function New-HostTaskAction([string] $Role) {
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '" -Role ' + $Role
    New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
}

$settingsOptions = @{
    StartWhenAvailable         = $true
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    MultipleInstances          = 'IgnoreNew'
    ExecutionTimeLimit         = [TimeSpan]::Zero
    RestartCount               = 999
    RestartInterval            = (New-TimeSpan -Minutes 1)
}
$settings = New-ScheduledTaskSettingsSet @settingsOptions

$hostTask = @{
    TaskName = 'AlphaCI Host'
    Force    = $true
    Action   = (New-HostTaskAction 'Keepalive')
    Settings = $settings
}
if ($OnlyWhenSignedIn) {
    $hostTask.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $ServiceAccount
    $hostTask.Principal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType Interactive -RunLevel Limited
} else {
    $credential = Get-Credential -UserName $ServiceAccount -Message 'Password for the account that owns the WSL distro'
    $hostTask.Trigger = New-ScheduledTaskTrigger -AtStartup
    $hostTask.User = $ServiceAccount
    $hostTask.Password = $credential.GetNetworkCredential().Password
    $hostTask.RunLevel = 'Limited'
}
Register-ScheduledTask @hostTask | Out-Null

$forwardTask = @{
    TaskName  = 'AlphaCI Port Forward'
    Force     = $true
    Action    = (New-HostTaskAction 'PortForward')
    Settings  = $settings
    Trigger   = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1))
    )
    Principal = (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest)
}
Register-ScheduledTask @forwardTask | Out-Null

foreach ($port in $Ports) {
    $name = 'AlphaCI TCP ' + $port
    if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) {
        Set-NetFirewallRule -Name $name -RemoteAddress $ClientSubnets -Enabled True
    } else {
        $rule = @{
            Name          = $name
            DisplayName   = $name
            Direction     = 'Inbound'
            Protocol      = 'TCP'
            LocalPort     = $port
            RemoteAddress = $ClientSubnets
            Action        = 'Allow'
            Profile       = 'Any'
        }
        New-NetFirewallRule @rule | Out-Null
    }
}

if ($ServiceAccount -eq $currentAccount -or -not $OnlyWhenSignedIn) {
    Start-ScheduledTask -TaskName 'AlphaCI Host'
}
Start-Sleep -Seconds 10
Start-ScheduledTask -TaskName 'AlphaCI Port Forward'
Start-Sleep -Seconds 3
Write-Output ('Distro address: ' + (Get-Content -LiteralPath (Join-Path $root 'wsl-address.txt') -ErrorAction SilentlyContinue))
& netsh.exe interface portproxy show v4tov4
Get-NetFirewallRule -Name 'AlphaCI TCP *' | Format-Table Name, Enabled, Direction, Action -AutoSize
