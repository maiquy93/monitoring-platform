#!/bin/bash
set -euo pipefail

echo "============================================================"
echo " [1/4] Tạo service systemd cho Monitoring Server..."
echo "============================================================"

cat << 'EOF' > /etc/systemd/system/monitoring-server.service
[Unit]
Description=Monitoring Platform Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mvquy
WorkingDirectory=/home/mvquy/Projects/monitoring-platform
Environment=ADMIN_PASSWORD=MatKhauBanDau-2026!
Environment=HOST=0.0.0.0
Environment=PORT=8080
Environment=DB_FILE=/home/mvquy/Projects/monitoring-platform/data/monitor.db
ExecStart=/home/mvquy/snap/antigravity-cli/common/nodejs/bin/node server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "==> Đã ghi file /etc/systemd/system/monitoring-server.service"

echo "============================================================"
echo " [2/4] Kích hoạt và khởi động monitoring-server.service..."
echo "============================================================"
systemctl daemon-reload
systemctl enable --now monitoring-server.service

echo "Chờ server khởi động..."
sleep 2

# Kiểm tra health
echo "Kiểm tra /api/health:"
curl -s http://127.0.0.1:8080/api/health || { echo "Server chưa phản hồi!"; exit 1; }
echo ""

echo "============================================================"
echo " [3/4] Cài đặt Monitoring Agent lên OS..."
echo "============================================================"
curl -fsSL http://127.0.0.1:8080/agent/install.sh | bash -s -- --key '622014dd6bdf5e24c64417f8270935ce5874ff24e907a801'

echo "============================================================"
echo " [4/4] Kiểm tra trạng thái cả hai dịch vụ..."
echo "============================================================"
echo "--- Trạng thái Server ---"
systemctl status monitoring-server.service --no-pager
echo ""
echo "--- Trạng thái Agent ---"
systemctl status monitoring-agent.service --no-pager

echo ""
echo "==> Triển khai hoàn tất thành công!"
