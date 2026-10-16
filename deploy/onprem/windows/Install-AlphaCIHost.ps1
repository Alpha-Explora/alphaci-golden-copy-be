#Requires -RunAsAdministrator
<#
.SYNOPSIS
Prepares a Windows host so its WSL distro serves AlphaCI releases to the client network. Safe to rerun.

.DESCRIPTION
Run after the distro has Docker Engine, systemd, and the agent (deploy/onprem/agent/install.sh).
It installs two scheduled tasks and one firewall rule per port:

  AlphaCI Host          as the account that owns the distro, not elevated: keeps it running.
  AlphaCI Port Forward  as SYSTEM, at startup and every minute: keeps netsh portproxy
                        pointed at the distro's current address for every port
                        assigned to this machine in AlphaCI, plus -Ports.
  AlphaCI TCP <port>    inbound, only from -ClientSubnets, added and removed with
                        the forwards.

An enrolled machine (-ApiUrl) forwards no static ports unless -Ports is given.
Add -ReplaceCredential with a replacement enrollment code to retire the current
machine credential. -EnrollCodeFile names a file holding the enrollment code
(the one-click install file writes it). The code is checked up front. The file is
deleted only after enrollment has taken the code, so a restart, a failed
prerequisite or an unreachable server leaves it for a rerun. Enrollment gets a copy
readable only by this account, deleted afterwards. Without it, the code is prompted for.

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
    [int[]] $Ports,
    [string] $ServiceAccount = ($env:USERDOMAIN + '\' + $env:USERNAME),
    [string] $ApiUrl,
    [string] $EnrollCodeFile,
    [switch] $ReplaceCredential,
    [switch] $OnlyWhenSignedIn
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'AlphaCI'
$startScript = Join-Path $root 'Start-AlphaCIHost.ps1'
$currentAccount = $env:USERDOMAIN + '\' + $env:USERNAME
# An enrolled machine forwards the ports of its assigned environments by itself;
# -Ports adds static ones. The single-environment agent publishes 443.
if (-not $PSBoundParameters.ContainsKey('Ports')) {
    $Ports = if ($ApiUrl -or (Test-Path -LiteralPath (Join-Path $root 'installation-state.json'))) { @() } else { @(443) }
}
if ($ReplaceCredential -and -not $ApiUrl) { throw 'ReplaceCredential requires -ApiUrl.' }
if ($EnrollCodeFile -and -not $ApiUrl) { throw 'EnrollCodeFile requires -ApiUrl.' }
# Read and check the code now. The file stays until enrollment has taken the code (below),
# so a restart, a failed prerequisite or an unreachable server leaves it for a rerun.
$enrollCode = $null
if ($EnrollCodeFile) {
    if (-not (Test-Path -LiteralPath $EnrollCodeFile -PathType Leaf)) { throw 'The enrollment code file is missing.' }
    $enrollCode = (Get-Content -Raw -LiteralPath $EnrollCodeFile).Trim()
    if ($enrollCode -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid enrollment code format.' }
}

New-Item -ItemType Directory -Force -Path $root, (Join-Path $root 'logs') | Out-Null
if ($ApiUrl) {
    $apiAddress = $null
    if (-not [uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$apiAddress) -or $apiAddress.Scheme -ne 'https' -or $apiAddress.UserInfo) {
        throw 'ApiUrl must be the public HTTPS AlphaCI API address without credentials.'
    }
    $statePath = Join-Path $root 'installation-state.json'
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else {
        [pscustomobject]@{ installationId = [guid]::NewGuid().ToString(); distro = $Distro; phase = 'prerequisites' }
    }
    if ($state.distro -ne $Distro) { throw 'This installation belongs to another distro. Use its saved distro or uninstall it explicitly.' }
    function Save-InstallPhase([string]$phase) {
        $state.phase = $phase
        $temporaryState = $statePath + '.tmp'
        $state | ConvertTo-Json | Set-Content -LiteralPath $temporaryState
        Move-Item -Force -LiteralPath $temporaryState -Destination $statePath
    }
    Save-InstallPhase 'prerequisites'
    Write-Host 'Checking Windows prerequisites (virtualization, WSL, Ubuntu)...'
    $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
    if (-not $processor.VirtualizationFirmwareEnabled) { throw 'Enable hardware virtualization in firmware, then rerun this installer.' }
    $restartRequired = $false
    foreach ($featureName in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
        if ($feature.State -ne 'Enabled') {
            Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart | Out-Null
            $restartRequired = $true
        }
    }
    if ($restartRequired) {
        Save-InstallPhase 'restart_required'
        Write-Output 'Restart Windows, then rerun this command. The saved installation identity will be reused.'
        # 3010 is the "restart required" code; the code file is still there for the rerun.
        exit 3010
    }
    if ($ServiceAccount -ne $currentAccount) { throw 'Enroll while signed in as the Windows account that owns this WSL distro, then configure its startup task.' }
    $installedDistros = @((& wsl.exe -l -q) -replace [char]0, '' | Where-Object { $_.Trim() })
    if ($installedDistros -notcontains $Distro) { throw ('Install an Ubuntu WSL2 distro for this account first: wsl --install -d ' + $Distro) }
    $distroDetails = (& wsl.exe -l -v) -replace [char]0, ''
    if (-not ($distroDetails | Where-Object { $_ -match ([regex]::Escape($Distro) + '\s+.*\s+2\s*$') })) { throw 'This host requires WSL2. Convert the selected distro with wsl --set-version before continuing.' }
    Save-InstallPhase 'enrollment'
    Write-Host ('Starting enrollment inside ' + $Distro + '...')
    # -e runs wslpath without the distro's shell, which would strip the backslashes
    # from a Windows path. Forward slashes keep the path intact either way.
    $agentDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\agent')).Path -replace '\\', '/'
    $linuxInstallerDirectory = ((& wsl.exe -d $Distro -e wslpath -u $agentDirectory) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $linuxInstallerDirectory) { throw 'Could not locate the extracted agent directory inside WSL.' }
    # Enrollment takes its code from a file that exists only for this run: written here,
    # readable only by this account, deleted in finally. No code or credential is passed in argv.
    $codeFile = $null
    try {
        $enrollArguments = @('-d', $Distro, '-u', 'root', '-e')
        if ($enrollCode) {
            $codeFile = Join-Path $env:TEMP ('alphaci-enroll-' + [guid]::NewGuid() + '.txt')
            [IO.File]::WriteAllText($codeFile, $enrollCode + "`n", [Text.UTF8Encoding]::new($false))
            # Grant by SID: an account name can be ambiguous, and a failed grant must not leave the code readable.
            $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            & icacls.exe $codeFile /inheritance:r /grant:r ('*' + $currentSid + ':(R,WA,D)') | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the enrollment code file to this account.' }
            $codeLinuxPath = ((& wsl.exe -d $Distro -e wslpath -u ($codeFile -replace '\\', '/')) -join '').Trim()
            if ($LASTEXITCODE -ne 0 -or -not $codeLinuxPath) { throw 'Could not pass the enrollment code to WSL.' }
            $enrollArguments += @('env', ('"ALPHACI_ENROLL_CODE_FILE=' + $codeLinuxPath + '"'))
        }
        $enrollArguments += @('bash', ('"' + $linuxInstallerDirectory + '/install.sh"'), '--enroll', $ApiUrl, 'windows')
        # A replacement code retires the credential already on this machine.
        if ($ReplaceCredential) { $enrollArguments += '--replace' }
        # Start-Process hands wsl.exe the console itself; called with &, PowerShell captures its
        # output line by line and the code prompt (no trailing newline) never appears.
        $installer = Start-Process -FilePath 'wsl.exe' -NoNewWindow -Wait -PassThru -ArgumentList $enrollArguments
        # enroll.sh deletes its copy once AlphaCi has answered. A copy still there means the outcome
        # is unknown, so the caller's file must stay for a rerun.
        $codeConsumed = [bool]$codeFile -and -not (Test-Path -LiteralPath $codeFile)
        if ($codeConsumed) { Remove-Item -Force -LiteralPath $EnrollCodeFile -ErrorAction SilentlyContinue }
        if ($installer.ExitCode -ne 0) { throw 'Ubuntu prerequisites or enrollment failed. Correct the reported issue and rerun; existing credentials are retained.' }
    } finally {
        if ($codeFile) { Remove-Item -Force -LiteralPath $codeFile -ErrorAction SilentlyContinue }
    }
    Write-Host 'Enrolled. Setting up startup and port forwarding...'
    Save-InstallPhase 'startup'
}
Copy-Item -Force -LiteralPath (Join-Path $PSScriptRoot 'Start-AlphaCIHost.ps1') -Destination $startScript
@{ Distro = $Distro; Ports = @($Ports); ClientSubnets = @($ClientSubnets) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'host.json')
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

# The port forward task adds and removes rules as ports are assigned; a rerun
# applies changed client subnets to the rules that already exist.
Get-NetFirewallRule -Name 'AlphaCI TCP *' -ErrorAction SilentlyContinue | ForEach-Object {
    Set-NetFirewallRule -Name $_.Name -RemoteAddress $ClientSubnets -Enabled True
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
if ($ApiUrl) { Save-InstallPhase 'complete' }
# A finished installation exits 0 explicitly, so an earlier native command never decides the result.
exit 0
