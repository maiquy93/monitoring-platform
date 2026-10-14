#!/bin/sh
set -u

CONFIG=${MONITORING_CONFIG:-/etc/monitoring-agent.conf}
[ -r "$CONFIG" ] && . "$CONFIG"
SERVER_URL=${SERVER_URL:-http://127.0.0.1:8080}
TOKEN=${TOKEN:-${ENROLL_KEY:-}}
AGENT_VERSION=${AGENT_VERSION:-1.0.0}
STATE=${STATE_FILE:-/var/lib/monitoring-agent/token}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g; s/$//'; }
local_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'
  return 0
}
cpu_data() {
  set -- $(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8}' /proc/stat)
  total=$(( $1+$2+$3+$4+$5+$6+$7 )); idle=$(( $4+$5 ))
  sleep 1
  set -- $(awk '/^cpu / {print $2,$3,$4,$5,$6,$7,$8}' /proc/stat)
  total2=$(( $1+$2+$3+$4+$5+$6+$7 )); idle2=$(( $4+$5 ))
  dt=$((total2-total)); di=$((idle2-idle)); percent=0
  [ "$dt" -gt 0 ] && percent=$(awk -v d="$dt" -v i="$di" 'BEGIN{printf "%.1f",100*(d-i)/d}')
  cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)
  load1=$(awk '{print $1}' /proc/loadavg)
  printf '%s %s %s\n' "$percent" "$cores" "$load1"
}
smart_data() {
  failing=0; msg=
  if command -v smartctl >/dev/null 2>&1; then
    for dev in $(ls /dev/sd[a-z] /dev/nvme[0-9]n1 /dev/vd[a-z] 2>/dev/null); do
      out=$(smartctl -H "$dev" 2>/dev/null || true)
      if echo "$out" | grep -Ei 'FAILED|FAILING|ATTRIBUTE.*FAILED' >/dev/null 2>&1; then
        failing=1; msg="$dev failing"
        break
      fi
    done
  fi
  if [ "$failing" -eq 1 ]; then
    printf '{"ok":false,"status":"failing","details":"%s"}' "$(json_escape "$msg")"
  else
    printf '{"ok":true,"status":"passed"}'
  fi
}
thermal_data() {
  temp=
  for z in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/hwmon*/temp*_input; do
    if [ -r "$z" ]; then
      read -r raw < "$z" 2>/dev/null || raw=
      if [ -n "$raw" ] && [ "$raw" -gt 0 ] 2>/dev/null; then
        if [ "$raw" -gt 1000 ]; then
          temp=$(awk -v r="$raw" 'BEGIN{printf "%.1f", r/1000}')
        else
          temp="$raw"
        fi
        break
      fi
    fi
  done
  if [ -z "$temp" ] && command -v sensors >/dev/null 2>&1; then
    stemp=$(sensors 2>/dev/null | awk '/Core 0|Package id 0|temp1/ {gsub("+",""); gsub("°C",""); print $2; exit}')
    if [ -n "$stemp" ] && [ "$stemp" != "0" ]; then temp="$stemp"; fi
  fi
  if [ -z "$temp" ] && command -v vcgencmd >/dev/null 2>&1; then
    vtemp=$(vcgencmd measure_temp 2>/dev/null | awk -F= '{gsub("'\''C",""); print $2}')
    if [ -n "$vtemp" ]; then temp="$vtemp"; fi
  fi
  if [ -n "$temp" ]; then printf '%s' "$temp"; else printf 'null'; fi
}
power_data() {
  on_bat=0; bat_pct=; status="ac"
  for bat in /sys/class/power_supply/BAT* /sys/class/power_supply/ups*; do
    if [ -d "$bat" ]; then
      [ -r "$bat/status" ] && read -r bstat < "$bat/status" 2>/dev/null || bstat=
      [ -r "$bat/capacity" ] && read -r bcap < "$bat/capacity" 2>/dev/null || bcap=
      if [ -n "$bcap" ]; then bat_pct="$bcap"; fi
      case "$bstat" in
        [Dd]ischarging*) on_bat=1; status="discharging" ;;
        *) status="ac" ;;
      esac
      break
    fi
  done
  if [ "$on_bat" -eq 0 ] && command -v upower >/dev/null 2>&1; then
    udev=$(upower -e 2>/dev/null | awk '/battery|ups/{print $1; exit}')
    if [ -n "$udev" ]; then
      uinfo=$(upower -i "$udev" 2>/dev/null || true)
      if echo "$uinfo" | grep -Ei 'state:[[:space:]]*discharging' >/dev/null 2>&1; then
        on_bat=1; status="discharging"
      fi
      upct=$(echo "$uinfo" | awk '/percentage:[[:space:]]*[0-9]+/{gsub("%","",$2); print $2; exit}')
      if [ -n "$upct" ]; then bat_pct="$upct"; fi
    fi
  fi
  if [ "$on_bat" -eq 1 ]; then
    if [ -n "$bat_pct" ]; then
      printf '{"on_battery":true,"battery_percent":%s,"status":"%s"}' "$bat_pct" "$status"
    else
      printf '{"on_battery":true,"battery_percent":null,"status":"%s"}' "$status"
    fi
  elif [ -n "$bat_pct" ]; then
    printf '{"on_battery":false,"battery_percent":%s,"status":"%s"}' "$bat_pct" "$status"
  else
    printf '{"on_battery":false,"battery_percent":null,"status":"ac"}'
  fi
}
payload() {
  host=$(hostname 2>/dev/null || echo unknown); ip=$(local_ip); [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$ip" ] || ip=
  set -- $(cpu_data); cpercent=$1; cores=$2; load1=$3
  total=$(awk '/MemTotal:/ {print $2*1024}' /proc/meminfo)
  avail=$(awk '/MemAvailable:/ {print $2*1024}' /proc/meminfo)
  used=$((total-avail)); mempercent=$(awk -v u="$used" -v t="$total" 'BEGIN{if(t)printf "%.1f",100*u/t;else print 0}')
  disks=$(df -P -k 2>/dev/null | awk 'NR>1 && $1 ~ /^\// {
    gsub("%","",$5); gsub(/\\/,"\\\\",$6); gsub(/"/,"\\\"",$6);
    printf "%s{\"mount\":\"%s\",\"total\":%d,\"used\":%d,\"percent\":%s}",(n++?",":""),$6,$2*1024,$3*1024,$5
  }')
  uptime_s=$(awk '{printf "%d",$1}' /proc/uptime)
  net=$(awk '{gsub(":", " "); if(NR>2 && $1 != "lo") {rx+=$2; tx+=$10}} END{printf "{\"rx_bytes\":%.0f,\"tx_bytes\":%.0f}", rx, tx}' /proc/net/dev 2>/dev/null || echo '{"rx_bytes":0,"tx_bytes":0}')
  temp=$(thermal_data)
  smart=$(smart_data)
  power=$(power_data)
  printf '{"hostname":"%s","os":"Linux","agent_version":"%s","ip":"%s","cpu":{"percent":%s,"cores":%s,"load1":%s},"memory":{"total":%s,"used":%s,"percent":%s},"disks":[%s],"uptime":%s,"net":%s,"temperature":%s,"smart":%s,"power":%s}' \
    "$(json_escape "$host")" "$(json_escape "$AGENT_VERSION")" "$(json_escape "$ip")" "$cpercent" "$cores" "$load1" "$total" "$used" "$mempercent" "$disks" "$uptime_s" "$net" "$temp" "$smart" "$power"
}
mkdir -p "$(dirname "$STATE")" 2>/dev/null || :
[ -s "$STATE" ] && TOKEN=$(cat "$STATE")
delay=5
while :; do
  body=$(payload)
  response=$(curl -fsS --connect-timeout 5 --max-time 15 -X POST "$SERVER_URL/api/agent/report" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "$body" 2>/dev/null) || response=
  if [ -n "$response" ]; then
    newtoken=$(printf '%s' "$response" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ -n "$newtoken" ]; then TOKEN=$newtoken; umask 077; printf '%s\n' "$TOKEN" > "$STATE"; fi
    delay=5; sleep 5
  else
    printf '%s\n' "monitoring-agent: report failed; retrying in ${delay}s" >&2
    sleep "$delay"; [ "$delay" -lt 30 ] && delay=$((delay*2)); [ "$delay" -gt 30 ] && delay=30
  fi
done
