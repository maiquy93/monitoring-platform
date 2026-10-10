$ErrorActionPreference = 'Stop'
$Config = if ($env:MONITORING_CONFIG) { $env:MONITORING_CONFIG } else { "$env:ProgramData\Monitoring\agent.ps1.config" }
if (Test-Path $Config) { . $Config }
$ServerUrl = if ($ServerUrl) { $ServerUrl } else { 'http://127.0.0.1:8080' }
$Token = if ($Token) { $Token } else { $EnrollKey }; $Version = '1.0.0'
$State = if ($StateFile) { $StateFile } else { "$env:ProgramData\Monitoring\token" }
New-Item (Split-Path $State) -ItemType Directory -Force | Out-Null
if (Test-Path $State) { $Token = (Get-Content $State -Raw).Trim() }
function Get-Payload {
  $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
  $cores = (Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown'} | Select-Object -First 1 -Expand IPAddress)
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{mount=$_.DeviceID;total=[int64]$_.Size;used=[int64]($_.Size-$_.FreeSpace);percent=[math]::Round(100*(1-$_.FreeSpace/$_.Size),1)} })
  [pscustomobject]@{hostname=$env:COMPUTERNAME;os='Windows';agent_version=$Version;ip=$ip;cpu=[pscustomobject]@{percent=[math]::Round($cpu,1);cores=$cores;load1=[math]::Round($cpu/100,2)};memory=[pscustomobject]@{total=[int64]$cs.TotalPhysicalMemory;used=[int64]($cs.TotalPhysicalMemory-$os.FreePhysicalMemory*1024);percent=[math]::Round(100*(1-$os.FreePhysicalMemory*1024/$cs.TotalVisibleMemorySize/1024),1)};disks=$disks;uptime=[int64]((Get-Date)-$os.LastBootUpTime).TotalSeconds}
}
$delay=5
while ($true) {
  try { $r=Invoke-RestMethod "$ServerUrl/api/agent/report" -Method Post -Headers @{Authorization="Bearer $Token"} -ContentType 'application/json' -Body ((Get-Payload)|ConvertTo-Json -Depth 5 -Compress); if ($r.token) {$Token=$r.token;Set-Content $State $Token -NoNewline};$delay=5;Start-Sleep 5 }
  catch { Write-Error "monitoring-agent: report failed; retrying in ${delay}s";Start-Sleep $delay;$delay=[math]::Min(30,$delay*2) }
}
