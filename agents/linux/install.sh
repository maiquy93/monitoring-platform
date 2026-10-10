#!/bin/sh
set -eu
server=${MONITORING_SERVER:-__SERVER_URL__}; key=
while [ "$#" -gt 0 ]; do case "$1" in --key) key=${2:-}; shift 2;; --server) server=${2:-}; shift 2;; --uninstall) systemctl disable --now monitoring-agent.service 2>/dev/null || :; rm -f /etc/systemd/system/monitoring-agent.service /etc/monitoring-agent.conf /usr/local/sbin/monitoring-agent; systemctl daemon-reload; exit 0;; *) shift;; esac; done
[ -n "$key" ] || { echo "usage: install.sh --key KEY [--server URL]" >&2; exit 2; }
install -d -m 700 /var/lib/monitoring-agent
curl -fsSL "$server/agent/linux/agent.sh" -o /usr/local/sbin/monitoring-agent
chmod 755 /usr/local/sbin/monitoring-agent
quote() { printf "%s" "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/'/"; }
umask 077; { printf 'SERVER_URL='; quote "$server"; printf '\nENROLL_KEY='; quote "$key"; printf '\nSTATE_FILE=/var/lib/monitoring-agent/token\n'; } > /etc/monitoring-agent.conf
cat > /etc/systemd/system/monitoring-agent.service <<'EOF'
[Unit]
Description=Monitoring Platform agent
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/sbin/monitoring-agent
Restart=always
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload; systemctl enable --now monitoring-agent.service
