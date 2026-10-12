#!/usr/bin/env bash
# ==============================================================================
# Script cài đặt Monitoring Agent trên hệ điều hành này với Enroll Key đã cho
# ==============================================================================
set -euo pipefail

ENROLL_KEY="${1:-8ce8bae3941a4a580c2a1d4356089b6ba7c9983d178f3e09}"
SERVER_URL="${2:-http://192.168.60.53:8080}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Vui lòng chạy bằng quyền root: sudo bash deploy/install-agent.sh"
  exit 1
fi

echo "==> Cài đặt Monitoring Agent..."
echo "    Server URL: $SERVER_URL"
echo "    Enroll Key: $ENROLL_KEY"

# 1. Tạo thư mục lưu state
install -d -m 700 /var/lib/monitoring-agent

# 2. Cài đặt file thực thi agent
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_AGENT_SH="$SCRIPT_DIR/../agents/linux/agent.sh"

if [ -f "$LOCAL_AGENT_SH" ]; then
  echo "==> Sao chép agent từ mã nguồn cục bộ..."
  cp "$LOCAL_AGENT_SH" /usr/local/sbin/monitoring-agent
else
  echo "==> Tải agent từ server..."
  curl -fsSL "$SERVER_URL/agent/linux/agent.sh" -o /usr/local/sbin/monitoring-agent
fi
chmod 755 /usr/local/sbin/monitoring-agent

# 3. Tạo file cấu hình /etc/monitoring-agent.conf
umask 077
cat > /etc/monitoring-agent.conf <<EOF
SERVER_URL='$SERVER_URL'
ENROLL_KEY='$ENROLL_KEY'
STATE_FILE=/var/lib/monitoring-agent/token
EOF
chmod 600 /etc/monitoring-agent.conf

# 4. Tạo systemd service
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

# 5. Kích hoạt và khởi chạy service
echo "==> Kích hoạt và khởi chạy monitoring-agent service..."
systemctl daemon-reload
systemctl enable --now monitoring-agent.service

echo "==> Trạng thái dịch vụ:"
systemctl status monitoring-agent.service --no-pager || true

echo "==> Hoàn tất cài đặt agent!"
