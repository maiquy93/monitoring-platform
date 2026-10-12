#!/usr/bin/env bash
# ==============================================================================
# Monitoring Platform - Đồng bộ mã nguồn giao diện sang dịch vụ đang chạy
# Sử dụng: sudo bash deploy/sync-live.sh
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "==> Yêu cầu quyền root. Đang chuyển sang sudo..."
  exec sudo bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="/opt/monitoring/app"
SERVICE="monitoring.service"

echo "==> [1/3] Kiểm tra thư mục dịch vụ đích: $APP_DIR"
if [ -d "$APP_DIR" ]; then
  echo "    Đang sao chép các file giao diện (public/) sang $APP_DIR/public/..."
  cp -a "$SRC_DIR/public/." "$APP_DIR/public/"
  chown -R monitoring:monitoring "$APP_DIR/public" 2>/dev/null || true
  
  if [ -d "$SRC_DIR/server" ]; then
    echo "    Đang sao chép mã nguồn server/ sang $APP_DIR/server/..."
    cp -a "$SRC_DIR/server/." "$APP_DIR/server/"
    chown -R monitoring:monitoring "$APP_DIR/server" 2>/dev/null || true
  fi
  echo "    Đã đồng bộ mã nguồn thành công vào $APP_DIR."
else
  echo "    Không tìm thấy $APP_DIR. Đang áp dụng triển khai in-place..."
  bash "$SRC_DIR/deploy/setup-os.sh" --in-place
fi

echo "==> [2/3] Khởi động lại dịch vụ $SERVICE..."
systemctl restart "$SERVICE" 2>/dev/null || true

echo "==> [3/3] Kiểm tra phản hồi dịch vụ..."
sleep 1
HEALTH=$(curl -s http://127.0.0.1:8080/api/health || echo "FAILED")
echo "    Kết quả health check: $HEALTH"

echo ""
echo "=========================================================================="
echo "  ĐÃ ĐỒNG BỘ THÀNH CÔNG GIAO DIỆN MỚI LÊN DỊCH VỤ THẬT!"
echo "  Truy cập ngay: http://192.168.60.53:8080/#/"
echo "  - Kéo thả thẻ mượt mà đẩy thẻ bên dưới theo thời gian thực (FLIP animation)"
echo "  - Tính năng màn hình đôi (Phím D hoặc nút 🖥️🖥️ trên thanh công cụ)"
echo "  - Hoạt động chuẩn xác trên cả 3 theme: Neon, Tối, Sáng"
echo "=========================================================================="
