#!/usr/bin/env bash
# Cập nhật Monitoring Platform trên Linux bằng MỘT lệnh:
#   sudo bash /opt/monitoring/app/deploy/update.sh
# Việc làm: lấy bản mới từ GitHub -> chạy test -> áp cấu hình tự dọn log/tự restart
#           -> khởi động lại dịch vụ -> kiểm tra /api/health. Lỗi thì tự quay về bản cũ.
set -euo pipefail

APP=${APP:-/opt/monitoring/app}
SERVICE=${SERVICE:-monitoring.service}
REPO=${REPO:-https://github.com/maiquy93/monitoring-platform.git}
BRANCH=${BRANCH:-main}
MIN_FREE_MB=${MIN_FREE_MB:-300}

[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"
# Chạy từ bản sao: git sẽ ghi đè file này trong lúc cập nhật.
if [ -z "${MONITORING_UPDATE_COPY:-}" ]; then
  SELF_COPY=$(mktemp); cp "$0" "$SELF_COPY"
  MONITORING_UPDATE_COPY=$SELF_COPY exec bash "$SELF_COPY" "$@"
fi
TMP=""
cleanup() { rm -f "$MONITORING_UPDATE_COPY"; [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nLỖI: %s\n' "$*" >&2; exit 1; }
for c in git node curl; do command -v "$c" >/dev/null || die "Thiếu lệnh '$c' (sudo apt-get install -y $c)"; done
[ -d "$APP" ] || die "Không thấy thư mục $APP (đặt APP=... nếu cài ở nơi khác)"

OWNER=$(stat -c %U "$APP")
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)
as_owner() { runuser -u "$OWNER" -- env HOME="${OWNER_HOME:-/tmp}" "$@"; }
free_mb() { df -Pm "$APP" | awk 'NR==2{print $4}'; }

PORT=$(systemctl show -p Environment --value "$SERVICE" 2>/dev/null | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)
PORT=${PORT:-8080}

say "Kiểm tra dung lượng ổ đĩa"
if [ "$(free_mb)" -lt "$MIN_FREE_MB" ]; then
  echo "Ổ đĩa gần đầy ($(free_mb) MB trống). Thử dọn log hệ thống..."
  journalctl --vacuum-size=200M >/dev/null 2>&1 || true
  apt-get clean >/dev/null 2>&1 || true
fi
[ "$(free_mb)" -ge "$MIN_FREE_MB" ] || die "Chỉ còn $(free_mb) MB trống. Chạy: sudo bash $APP/deploy/disk-report.sh để tìm thứ chiếm ổ đĩa."

PREV=""
say "Lấy bản mới ($REPO, nhánh $BRANCH)"
if [ -d "$APP/.git" ]; then
  PREV=$(as_owner git -C "$APP" rev-parse HEAD)
  as_owner git -C "$APP" fetch origin "$BRANCH"
  as_owner git -C "$APP" reset --hard "origin/$BRANCH"
else
  echo "Thư mục chưa phải git repo: tải về và chép đè (database nằm ngoài thư mục này nên không bị ảnh hưởng)."
  TMP=$(mktemp -d)
  git clone --branch "$BRANCH" "$REPO" "$TMP/src"
  cp -a "$TMP/src/." "$APP/"
  chown -R "$OWNER": "$APP"
fi
SHA=$(as_owner git -C "$APP" rev-parse --short HEAD 2>/dev/null || echo unknown)
printf '%s %s\n' "$SHA" "$(date -u +%FT%TZ)" > "$APP/BUILD"; chown "$OWNER": "$APP/BUILD"
echo "Đã ở bản: $SHA"

rollback() {
  [ -n "$PREV" ] || return 0
  echo "Quay về bản cũ ${PREV:0:7}..."
  as_owner git -C "$APP" reset --hard "$PREV"
  systemctl restart "$SERVICE" || true
}

say "Chạy test"
if ! (cd "$APP" && as_owner node --test test/*.test.js >/tmp/monitoring-update-test.log 2>&1); then
  tail -30 /tmp/monitoring-update-test.log
  rollback
  die "Test không đạt, giữ nguyên bản đang chạy. Log: /tmp/monitoring-update-test.log"
fi
echo "Test đạt."

say "Áp cấu hình tự khởi động lại và giới hạn log"
CHANGED=0
install_conf() { # nguồn đích
  mkdir -p "$(dirname "$2")"
  if ! cmp -s "$1" "$2" 2>/dev/null; then install -m 644 "$1" "$2"; CHANGED=1; fi
}
install_conf "$APP/deploy/monitoring-restart.conf" "/etc/systemd/system/$SERVICE.d/restart.conf"
JOURNAL_CHANGED=0
if ! cmp -s "$APP/deploy/journald-monitoring.conf" /etc/systemd/journald.conf.d/monitoring.conf 2>/dev/null; then
  install_conf "$APP/deploy/journald-monitoring.conf" /etc/systemd/journald.conf.d/monitoring.conf; JOURNAL_CHANGED=1
fi
[ "$CHANGED" -eq 0 ] || systemctl daemon-reload
[ "$JOURNAL_CHANGED" -eq 0 ] || systemctl restart systemd-journald

say "Khởi động lại dịch vụ"
systemctl restart "$SERVICE"
OK=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" -o /tmp/monitoring-health.json 2>/dev/null; then OK=1; break; fi
  sleep 1
done
if [ "$OK" -ne 1 ]; then
  journalctl -u "$SERVICE" --no-pager -n 30 || true
  rollback
  die "Dịch vụ không trả lời /api/health trên cổng $PORT sau 30 giây."
fi

say "Hoàn tất"
echo "Health: $(cat /tmp/monitoring-health.json)"
echo "Kiểm tra dung lượng:  sudo bash $APP/deploy/disk-report.sh"
