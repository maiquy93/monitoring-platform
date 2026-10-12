$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$Config = if ($env:MONITORING_CONFIG) { $env:MONITORING_CONFIG } else { "$env:ProgramData\Monitoring\agent.ps1.config" }
if (Test-Path $Config) { . ([scriptblock]::Create((Get-Content $Config -Raw))) }
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
  $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Where-Object { $_.Size -gt 0 } | ForEach-Object {
    $size = [int64]$_.Size; $free = [int64]$_.FreeSpace
    [pscustomobject]@{mount=$_.DeviceID;total=$size;used=($size-$free);percent=[math]::Round(100 * (1 - ($free / $size)),1)}
  })
  $total = [int64]$cs.TotalPhysicalMemory; $free = [int64]$os.FreePhysicalMemory * 1024
  $used = $total - $free; if ($used -lt 0) { $used = 0 }
  $memoryPercent = if ($total -gt 0) { [math]::Round(100 * $used / $total, 1) } else { 0 }
  $cpuPercent = if ($null -eq $cpu) { 0 } else { [math]::Round($cpu,1) }
  $netStat = @(Get-NetAdapterStatistics 2>$null)
  if ($netStat.Count -gt 0) {
    $rx = ($netStat | Measure-Object -Property ReceivedBytes -Sum).Sum
    $tx = ($netStat | Measure-Object -Property SentBytes -Sum).Sum
  } else {
    $perf = @(Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface 2>$null | Where-Object { $_.Name -notlike '*Loopback*' })
    $rx = ($perf | Measure-Object -Property BytesReceivedPersec -Sum).Sum
    $tx = ($perf | Measure-Object -Property BytesSentPersec -Sum).Sum
  }
  $temp = $null
  try {
    $tz = Get-CimInstance -Namespace "root/wmi" -ClassName "MSAcpi_ThermalZoneTemperature" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($tz -and $tz.CurrentTemperature -gt 2732) {
      $temp = [math]::Round(($tz.CurrentTemperature - 2732) / 10.0, 1)
    }
  } catch {}
  $smart = [pscustomobject]@{ok=$true;status='passed';details=''}
  try {
    $badDisks = @(Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue | Where-Object { $_.Status -and $_.Status -ne 'OK' })
    if ($badDisks.Count -gt 0) {
      $smart = [pscustomobject]@{ok=$false;status='failing';details="Disks failing: $($badDisks.DeviceID -join ', ')"}
    }
  } catch {}
  $power = $null
  try {
    $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bat) {
      $onBat = ($bat.BatteryStatus -eq 1)
      $power = [pscustomobject]@{on_battery=$onBat;battery_percent=[int]$bat.EstimatedChargeRemaining;status=(if ($onBat) {'discharging'} else {'ac'})}
    }
  } catch {}
  [pscustomobject]@{hostname=$env:COMPUTERNAME;os='Windows';agent_version=$Version;ip=$ip;cpu=[pscustomobject]@{percent=$cpuPercent;cores=$cores;load1=[math]::Round($cpuPercent/100,2)};memory=[pscustomobject]@{total=$total;used=$used;percent=$memoryPercent};disks=$disks;uptime=[int64]((Get-Date)-$os.LastBootUpTime).TotalSeconds;net=[pscustomobject]@{rx_bytes=[int64]($rx ?? 0);tx_bytes=[int64]($tx ?? 0)};temperature=$temp;smart=$smart;power=$power}
}
$delay=5
while ($true) {
  try { $r=Invoke-RestMethod "$ServerUrl/api/agent/report" -Method Post -Headers @{Authorization="Bearer $Token"} -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(((Get-Payload)|ConvertTo-Json -Depth 5 -Compress))); if ($r.token) {$Token=$r.token;Set-Content $State $Token -NoNewline};$delay=5;Start-Sleep 5 }
  catch { Write-Warning "monitoring-agent: $($_.Exception.Message); retrying in ${delay}s";Start-Sleep $delay;$delay=[math]::Min(30,$delay*2) }
}
