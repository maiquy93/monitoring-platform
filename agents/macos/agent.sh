#!/bin/sh
set -u
CONFIG=${MONITORING_CONFIG:-/Library/Application Support/Monitoring/agent.conf}; [ -r "$CONFIG" ] && . "$CONFIG"
SERVER_URL=${SERVER_URL:-http://127.0.0.1:8080}; TOKEN=${TOKEN:-${ENROLL_KEY:-}}; AGENT_VERSION=${AGENT_VERSION:-1.0.0}
STATE=${STATE_FILE:-/Library/Application Support/Monitoring/token}; mkdir -p "$(dirname "$STATE")" 2>/dev/null || :
[ -s "$STATE" ] && TOKEN=$(cat "$STATE")
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
ipaddr() { route get default 2>/dev/null | awk '/interface:/{i=$2} END{if(i){"ifconfig " i | getline; close("ifconfig " i)}}' 2>/dev/null; }
listening_ports() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP -sTCP:LISTEN -iUDP 2>/dev/null | awk 'NR>1 {
      cmd = $1; proto = tolower($5);
      if (proto ~ /tcp/) proto = "tcp";
      else if (proto ~ /udp/) proto = "udp";
      else next;
      addr = $9;
      n = split(addr, a, ":");
      port = a[n] + 0;
      if (port < 1 || port > 65535) next;
      key = proto ":" port;
      if (!seen[key]) {
        seen[key] = 1; order[++count] = key;
        protos[key] = proto; ports[key] = port; svcs[key] = cmd;
      }
    }
    END {
      printf "[";
      for (i = 1; i <= count; i++) {
        k = order[i]; if (i > 1) printf ",";
        s = svcs[k]; gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s);
        printf "{\"proto\":\"%s\",\"port\":%d,\"service\":\"%s\"}", protos[k], ports[k], s;
      }
      printf "]";
    }'
  else
    printf '[]'
  fi
}
payload() {
 host=$(scutil --get ComputerName 2>/dev/null || hostname); ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '')
 cores=$(sysctl -n hw.ncpu); load=$(sysctl -n vm.loadavg | tr -d '{} ' | cut -d, -f1)
 cpu=$(top -l 1 -n 0 2>/dev/null | awk -F'[:,%]' '/CPU usage/ {i=$6; gsub(/ /,"",i); print 100-i; exit}')
 [ -n "$cpu" ] || cpu=0
 total=$(sysctl -n hw.memsize); pagesize=$(vm_stat | awk '/page size/{print $8}'); free=$(vm_stat | awk '/Pages free/{gsub("\\.","");print $3}'); inactive=$(vm_stat | awk '/Pages inactive/{gsub("\\.","");print $3}')
 used=$((total-(free+inactive)*pagesize)); pct=$(awk -v u="$used" -v t="$total" 'BEGIN{printf "%.1f",100*u/t}')
 disks=$(df -kP | awk 'NR>1 && $1 ~ /^\// {gsub("%","",$5); printf "%s{\"mount\":\"%s\",\"total\":%d,\"used\":%d,\"percent\":%d}",(n++?",":""),$6,$2*1024,$3*1024,$5}')
 uptime_s=$(sysctl -n kern.boottime | awk -F'[ ,}]+' '{print systime()-$4}')
 net=$(netstat -ibn 2>/dev/null | awk '/<Link#[0-9]>/ && $1 !~ /^lo/ {rx+=$7; tx+=$10} END{printf "{\"rx_bytes\":%.0f,\"tx_bytes\":%.0f}", rx, tx}')
 [ -n "$net" ] || net='{"rx_bytes":0,"tx_bytes":0}'
 lports=$(listening_ports)
 printf '{"hostname":"%s","os":"macOS","agent_version":"%s","ip":"%s","cpu":{"percent":%s,"cores":%s,"load1":%s},"memory":{"total":%s,"used":%s,"percent":%s},"disks":[%s],"uptime":%s,"net":%s,"listening_ports":%s}' "$(esc "$host")" "$AGENT_VERSION" "$(esc "$ip")" "$cpu" "$cores" "$load" "$total" "$used" "$pct" "$disks" "$uptime_s" "$net" "$lports"
}
delay=5
while :; do response=$(curl -fsS --connect-timeout 5 --max-time 15 -X POST "$SERVER_URL/api/agent/report" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data "$(payload)" 2>/dev/null) || response=
 if [ -n "$response" ]; then t=$(printf '%s' "$response"|sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'); if [ -n "$t" ]; then TOKEN=$t; umask 077; printf '%s\n' "$TOKEN" > "$STATE"; fi; delay=5; sleep 5
 else echo "monitoring-agent: report failed; retrying in ${delay}s" >&2; sleep "$delay"; [ "$delay" -lt 30 ] && delay=$((delay*2)); [ "$delay" -gt 30 ] && delay=30; fi
done
