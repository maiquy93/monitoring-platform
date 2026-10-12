#!/usr/bin/env bash
# ==============================================================================
# Script áp dụng cấu hình IP tĩnh 192.168.60.53 cho interface ens33
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Vui lòng chạy bằng quyền root: sudo bash deploy/apply-static-ip.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_FILE="$SCRIPT_DIR/01-netcfg.yaml"
NETPLAN_DIR="/etc/netplan"
BACKUP_DIR="/etc/netplan/backup_$(date +%Y%m%d_%H%M%S)"

echo "==> Đang sao lưu cấu hình netplan cũ vào $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
cp -a "$NETPLAN_DIR"/*.yaml "$BACKUP_DIR"/ 2>/dev/null || true

echo "==> Sao chép cấu hình IP tĩnh mới vào $NETPLAN_DIR/01-netcfg.yaml..."
# Di chuyển các file cấu hình cũ tránh xung đột DHCP nếu có
for f in "$NETPLAN_DIR"/*.yaml; do
  [ -f "$f" ] || continue
  mv "$f" "$BACKUP_DIR"/
done

cp "$CONF_FILE" "$NETPLAN_DIR/01-netcfg.yaml"
chmod 600 "$NETPLAN_DIR/01-netcfg.yaml"

echo "==> Áp dụng cấu hình netplan..."
netplan apply

echo "==> Hoàn tất! Thông tin IP hiện tại:"
ip a show ens33 || true
ip route show || true
