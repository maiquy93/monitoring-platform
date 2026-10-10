param([string]$Key,[string]$Server='__SERVER_URL__',[switch]$Uninstall)
$dir="$env:ProgramData\Monitoring";$runner="$dir\agent.ps1";$cfg="$dir\agent.ps1.config";$task='Monitoring Platform Agent'
if($Uninstall){Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName $task -Confirm:$false;Remove-Item $runner,$cfg -Force -ErrorAction SilentlyContinue;exit}
if(!$Key){throw 'Usage: install.ps1 -Key KEY [-Server URL]'}
New-Item $dir -ItemType Directory -Force|Out-Null
$agentUrl=if($env:MONITORING_AGENT_URL){$env:MONITORING_AGENT_URL}else{"$Server/agent/windows/agent.ps1"}
try{[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12}catch{}
Invoke-WebRequest $agentUrl -OutFile $runner -UseBasicParsing
Set-Content $cfg "`$ServerUrl='$Server'`n`$EnrollKey='$Key'`n`$StateFile='$dir\token'" -Force
$a=New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$t=New-ScheduledTaskTrigger -AtStartup
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $a -Trigger $t -Settings $s -User SYSTEM -RunLevel Highest -Force
Start-ScheduledTask -TaskName $task
