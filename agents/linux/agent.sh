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
payload() {
  host=$(hostname 2>/dev/null || echo unknown); ip=$(local_ip); [ -n "$ip" ] || ip=
  set -- $(cpu_data); cpercent=$1; cores=$2; load1=$3
  total=$(awk '/MemTotal:/ {print $2*1024}' /proc/meminfo)
  avail=$(awk '/MemAvailable:/ {print $2*1024}' /proc/meminfo)
  used=$((total-avail)); mempercent=$(awk -v u="$used" -v t="$total" 'BEGIN{if(t)printf "%.1f",100*u/t;else print 0}')
  disks=$(df -P -k 2>/dev/null | awk 'NR>1 && $1 ~ /^\// {
    gsub("%","",$5); gsub(/\\/,"\\\\",$6); gsub(/"/,"\\\"",$6);
    printf "%s{\"mount\":\"%s\",\"total\":%d,\"used\":%d,\"percent\":%s}",(n++?",":""),$6,$2*1024,$3*1024,$5
  }')
  uptime_s=$(awk '{printf "%d",$1}' /proc/uptime)
  printf '{"hostname":"%s","os":"Linux","agent_version":"%s","ip":"%s","cpu":{"percent":%s,"cores":%s,"load1":%s},"memory":{"total":%s,"used":%s,"percent":%s},"disks":[%s],"uptime":%s}' \
    "$(json_escape "$host")" "$(json_escape "$AGENT_VERSION")" "$(json_escape "$ip")" "$cpercent" "$cores" "$load1" "$total" "$used" "$mempercent" "$disks" "$uptime_s"
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
