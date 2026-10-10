#!/bin/sh
set -eu
server=${MONITORING_SERVER:-__SERVER_URL__}; key=
while [ "$#" -gt 0 ]; do case "$1" in --key) key=${2:-}; shift 2;; --server) server=${2:-}; shift 2;; --uninstall) launchctl bootout system /Library/LaunchDaemons/com.monitoring.agent.plist 2>/dev/null || :; rm -f /Library/LaunchDaemons/com.monitoring.agent.plist /usr/local/libexec/monitoring-agent /Library/Application\ Support/Monitoring/agent.conf; exit 0;; *) shift;; esac; done
[ -n "$key" ] || { echo "usage: install.sh --key KEY [--server URL]" >&2; exit 2; }
install -d -m 700 "/Library/Application Support/Monitoring"; curl -fsSL "$server/agent/macos/agent.sh" -o /usr/local/libexec/monitoring-agent; chmod 755 /usr/local/libexec/monitoring-agent
quote() { printf "%s" "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/'/"; }
umask 077; { printf 'SERVER_URL='; quote "$server"; printf '\nENROLL_KEY='; quote "$key"; printf '\nSTATE_FILE=/Library/Application Support/Monitoring/token\n'; } > "/Library/Application Support/Monitoring/agent.conf"
cat > /Library/LaunchDaemons/com.monitoring.agent.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.monitoring.agent</string><key>ProgramArguments</key><array><string>/usr/local/libexec/monitoring-agent</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>UserName</key><string>root</string></dict></plist>
EOF
launchctl bootstrap system /Library/LaunchDaemons/com.monitoring.agent.plist
