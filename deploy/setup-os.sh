#!/usr/bin/env bash
# ==============================================================================
# Monitoring Platform - Linux Deployment & Systemd Service Setup Script
# Theo tài liệu hướng dẫn README.md:
# - Cài đặt gói phụ thuộc hệ thống (curl, iputils-ping, Node.js >= 22.5)
# - Tạo user chuyên dụng 'monitoring' và thư mục /opt/monitoring/app, /var/lib/monitoring
# - Sao chép mã nguồn và thiết lập phân quyền
# - Khởi tạo cấu hình bảo mật /etc/monitoring/monitoring.env
# - Cấu hình systemd service tự động khởi động cùng hệ điều hành (không mất dịch vụ khi reboot)
# - Áp dụng drop-in tự phục hồi (restart.conf) và tối ưu journald
# - Kiểm tra /api/health
# ==============================================================================
set -euo pipefail

# 1. Yêu cầu quyền root
if [ "$(id -u)" -ne 0 ]; then
  echo "==> Yêu cầu quyền root. Đang tự động chuyển sang sudo..."
  exec sudo bash "$0" "$@"
fi

# Màu sắc hiển thị terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

say() { echo -e "\n${BLUE}==>${NC} ${GREEN}$*${NC}"; }
warn() { echo -e "${YELLOW}CẢNH BÁO: $*${NC}" >&2; }
die() { echo -e "${RED}LỖI: $*${NC}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Kiểm tra thư mục mã nguồn
[ -f "$SRC_DIR/server/index.js" ] || die "Không tìm thấy server/index.js tại $SRC_DIR"

IN_PLACE=0
for arg in "$@"; do
  case "$arg" in
    --in-place)
      IN_PLACE=1
      ;;
    --help|-h)
      echo "Cách sử dụng: sudo bash deploy/setup-os.sh [tùy chọn]"
      echo ""
      echo "Tùy chọn:"
      echo "  --in-place    Chạy trực tiếp từ thư mục mã nguồn hiện tại thay vì sao chép vào /opt/monitoring/app"
      echo "  --help, -h    Hiển thị trợ giúp này"
      exit 0
      ;;
  esac
done

if [ "$IN_PLACE" -eq 1 ]; then
  APP_DIR="$SRC_DIR"
  APP_USER="$(stat -c %U "$SRC_DIR")"
  APP_GROUP="$(stat -c %G "$SRC_DIR")"
  DB_FILE="$SRC_DIR/data/monitor.db"
  say "Chế độ: Triển khai trực tiếp tại thư mục hiện tại ($APP_DIR) với user $APP_USER"
else
  APP_DIR="/opt/monitoring/app"
  APP_USER="monitoring"
  APP_GROUP="monitoring"
  DB_FILE="/var/lib/monitoring/monitor.db"
  say "Chế độ: Triển khai chuẩn Production theo README (/opt/monitoring/app, user monitoring)"
fi

SERVICE="monitoring.service"
PORT="${PORT:-8080}"
HOST="${HOST:-0.0.0.0}"
DEFAULT_PASS="MatKhauBanDau-2026!"

# ------------------------------------------------------------------------------
# Bước 1: Kiểm tra và cài đặt các gói phụ thuộc hệ điều hành
# ------------------------------------------------------------------------------
say "[1/6] Kiểm tra gói phụ thuộc hệ điều hành (curl, iputils-ping, Node.js >= 22.5)..."

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local ver major minor
  ver=$(node -v 2>/dev/null | tr -d 'v')
  major=$(echo "$ver" | cut -d. -f1)
  minor=$(echo "$ver" | cut -d. -f2)
  if [ -n "$major" ] && [ -n "$minor" ]; then
    if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }; then
      return 0
    fi
  fi
  return 1
}

if command -v apt-get >/dev/null 2>&1; then
  MISSING_PKGS=()
  for pkg in ca-certificates curl iputils-ping; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
      MISSING_PKGS+=("$pkg")
    fi
  done
  if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    echo "Cài đặt các gói thiếu: ${MISSING_PKGS[*]}..."
    apt-get update -y
    apt-get install -y "${MISSING_PKGS[@]}"
  fi
fi

if ! check_node; then
  echo "Node.js >= 22.5 chưa được cài đặt (cần cho thư viện chuẩn node:sqlite)."
  if command -v apt-get >/dev/null 2>&1; then
    echo "Đang cài đặt Node.js 22 LTS từ kho NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    warn "Không thể tự động cài đặt Node.js trên hệ điều hành này. Vui lòng cài đặt Node.js >= 22.5 trước."
  fi
fi

check_node || die "Yêu cầu Node.js phiên bản >= 22.5 để chạy dự án. Hiện tại: $(node -v 2>/dev/null || echo 'chưa cài')"
NODE_BIN=$(command -v node)
echo "Sử dụng Node.js: $NODE_BIN ($($NODE_BIN -v))"

# ------------------------------------------------------------------------------
# Bước 2: Tạo User và các thư mục theo tài liệu hướng dẫn
# ------------------------------------------------------------------------------
say "[2/6] Thiết lập người dùng và thư mục hệ thống..."

if [ "$IN_PLACE" -eq 0 ]; then
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    echo "Tạo system user '$APP_USER'..."
    useradd --system --create-home --home-dir /opt/monitoring "$APP_USER"
  fi
  mkdir -p /opt/monitoring/app /var/lib/monitoring
  if [ ! -f "$DB_FILE" ] && [ -f "$SRC_DIR/data/monitor.db" ]; then
    echo "Sao chép database từ $SRC_DIR/data sang /var/lib/monitoring/..."
    cp -a "$SRC_DIR/data/monitor.db"* /var/lib/monitoring/ 2>/dev/null || true
  fi
  chown -R "$APP_USER:$APP_GROUP" /opt/monitoring /var/lib/monitoring
  chmod 750 /var/lib/monitoring
else
  mkdir -p "$(dirname "$DB_FILE")"
  if [ ! -f "$DB_FILE" ] && [ -f /var/lib/monitoring/monitor.db ]; then
    echo "Sao chép database hiện có từ /var/lib/monitoring sang $(dirname "$DB_FILE")..."
    cp -a /var/lib/monitoring/monitor.db* "$(dirname "$DB_FILE")/" 2>/dev/null || true
  fi
  chown -R "$APP_USER:$APP_GROUP" "$(dirname "$DB_FILE")"
  chmod 755 "$(dirname "$DB_FILE")"
fi
mkdir -p /etc/monitoring

# ------------------------------------------------------------------------------
# Bước 3: Đồng bộ mã nguồn dự án
# ------------------------------------------------------------------------------
say "[3/6] Đồng bộ mã nguồn ứng dụng..."

if [ "$IN_PLACE" -eq 0 ]; then
  echo "Sao chép mã nguồn từ $SRC_DIR sang $APP_DIR..."
  mkdir -p "$APP_DIR"
  cp -a "$SRC_DIR/." "$APP_DIR/"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
fi

# Ghi thông tin bản build
if command -v git >/dev/null 2>&1 && [ -d "$APP_DIR/.git" ]; then
  SHA=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo "prod")
  printf '%s %s\n' "$SHA" "$(date -u +%FT%TZ)" > "$APP_DIR/BUILD"
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/BUILD" 2>/dev/null || true
fi

# ------------------------------------------------------------------------------
# Bước 4: Cấu hình mật khẩu và file môi trường
# ------------------------------------------------------------------------------
say "[4/6] Cấu hình file môi trường /etc/monitoring/monitoring.env..."

if [ ! -f /etc/monitoring/monitoring.env ]; then
  PASS="${ADMIN_PASSWORD:-$DEFAULT_PASS}"
  printf "ADMIN_PASSWORD=%s\n" "$PASS" > /etc/monitoring/monitoring.env
  echo "Đã tạo /etc/monitoring/monitoring.env với mật khẩu ban đầu."
else
  echo "File /etc/monitoring/monitoring.env đã tồn tại, giữ nguyên cấu hình hiện có."
fi
# Đồng bộ DB_FILE nếu trong file env đang cấu hình đường dẫn khác
if grep -q '^DB_FILE=' /etc/monitoring/monitoring.env 2>/dev/null; then
  sed -i "s|^DB_FILE=.*|DB_FILE=${DB_FILE}|" /etc/monitoring/monitoring.env
fi
chmod 600 /etc/monitoring/monitoring.env
chown root:root /etc/monitoring/monitoring.env

# ------------------------------------------------------------------------------
# Bước 5: Tạo và cấu hình systemd service (Tự khởi động cùng OS)
# ------------------------------------------------------------------------------
say "[5/6] Cấu hình systemd service tự động khởi động cùng OS..."

# Dọn dẹp service cũ nếu từng tạo trước đó để tránh xung đột cổng
if [ -f /etc/systemd/system/monitoring-server.service ]; then
  echo "Dọn dẹp service cũ monitoring-server.service..."
  systemctl stop monitoring-server.service 2>/dev/null || true
  systemctl disable monitoring-server.service 2>/dev/null || true
  rm -f /etc/systemd/system/monitoring-server.service
fi

cat << EOF > /etc/systemd/system/${SERVICE}
[Unit]
Description=Monitoring Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=HOST=${HOST}
Environment=PORT=${PORT}
Environment=DB_FILE=${DB_FILE}
EnvironmentFile=-/etc/monitoring/monitoring.env
ExecStart=${NODE_BIN} server/index.js
Restart=always
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "Đã ghi file /etc/systemd/system/${SERVICE}"

# Cài đặt cấu hình tối ưu tự khởi động lại và giới hạn dung lượng log journald
if [ -f "$APP_DIR/deploy/monitoring-restart.conf" ]; then
  mkdir -p "/etc/systemd/system/${SERVICE}.d"
  cp "$APP_DIR/deploy/monitoring-restart.conf" "/etc/systemd/system/${SERVICE}.d/restart.conf"
fi

if [ -f "$APP_DIR/deploy/journald-monitoring.conf" ]; then
  mkdir -p /etc/systemd/journald.conf.d
  cp "$APP_DIR/deploy/journald-monitoring.conf" /etc/systemd/journald.conf.d/monitoring.conf
  systemctl restart systemd-journald 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable "${SERVICE}"
echo "Đã kích hoạt tự khởi động cho ${SERVICE} khi boot OS (systemctl enable ${SERVICE})"

say "Khởi động dịch vụ ${SERVICE}..."
systemctl restart "${SERVICE}"

# ------------------------------------------------------------------------------
# Bước 6: Kiểm tra trạng thái và xác nhận hoạt động
# ------------------------------------------------------------------------------
say "[6/6] Kiểm tra phản hồi dịch vụ..."

HEALTHY=0
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" -o /tmp/monitoring-health.json 2>/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  echo -e "${RED}LỖI: Dịch vụ chưa phản hồi /api/health sau 15 giây!${NC}"
  journalctl -u "${SERVICE}" -n 30 --no-pager || true
  exit 1
fi

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
HOST_IP=${HOST_IP:-127.0.0.1}

echo ""
echo "=========================================================================="
echo -e "${GREEN}        TRIỂN KHAI THÀNH CÔNG MONITORING PLATFORM!${NC}"
echo "=========================================================================="
echo "Dịch vụ đã được cấu hình trong systemd (${SERVICE}) và tự khởi động khi reboot OS."
echo ""
echo "  - URL truy cập:       http://${HOST_IP}:${PORT}"
echo "  - Tài khoản mặc định: admin"
echo "  - Mật khẩu ban đầu:   $(grep '^ADMIN_PASSWORD=' /etc/monitoring/monitoring.env | cut -d= -f2-)"
echo "  - File cấu hình:      /etc/monitoring/monitoring.env"
echo "  - Thư mục database:   ${DB_FILE}"
echo "  - Thư mục ứng dụng:   ${APP_DIR}"
echo ""
echo "Các lệnh quản trị hữu ích:"
echo "  - Xem trạng thái:         sudo systemctl status ${SERVICE}"
echo "  - Xem log thời gian thực: sudo journalctl -u ${SERVICE} -f"
echo "  - Khởi động lại:          sudo systemctl restart ${SERVICE}"
echo "  - Cập nhật phiên bản:     sudo bash ${APP_DIR}/deploy/update.sh"
echo "  - Báo cáo dung lượng:     sudo bash ${APP_DIR}/deploy/disk-report.sh"
echo ""
echo "Cài đặt Agent lên các máy cần giám sát (hoặc chính server này):"
echo "  1. Mở http://${HOST_IP}:${PORT} -> Đăng nhập và đổi mật khẩu lần đầu."
echo "  2. Vào Cài đặt -> Đăng ký agent tự động -> Bấm 'Tạo ngẫu nhiên' rồi lưu enroll key."
echo "  3. Chạy lệnh cài đặt agent trên máy đích:"
echo "     curl -fsSL http://${HOST_IP}:${PORT}/agent/install.sh | sudo bash -s -- --key '<ENROLL_KEY>'"
echo "=========================================================================="
