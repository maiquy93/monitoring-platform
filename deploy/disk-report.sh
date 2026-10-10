#!/usr/bin/env bash
# Báo cáo dung lượng ổ đĩa và tìm thứ chiếm chỗ.
#   sudo bash deploy/disk-report.sh          # chỉ xem
#   sudo bash deploy/disk-report.sh --fix    # xem + dọn phần an toàn (log hệ thống, cache apt)
set -uo pipefail
[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"
DB_DIR=${DB_DIR:-/var/lib/monitoring}

echo "=== Dung lượng / và inode ==="; df -h /; df -i / | tail -1
echo; echo "=== Thư mục lớn nhất trên / ==="; du -xh / --max-depth=1 2>/dev/null | sort -rh | head -12
echo; echo "=== Trong /var ==="; du -xh /var --max-depth=2 2>/dev/null | sort -rh | head -10
echo; echo "=== Log hệ thống (journal) ==="; journalctl --disk-usage
echo; echo "=== Database của Monitoring ==="; ls -lh "$DB_DIR"/monitor.db* 2>/dev/null || echo "(không thấy $DB_DIR/monitor.db)"
echo; echo "=== Cache apt ==="; du -sh /var/cache/apt 2>/dev/null
if command -v docker >/dev/null; then echo; echo "=== Docker ==="; docker system df 2>/dev/null; fi
echo; echo "=== 10 file lớn hơn 200 MB ==="
find / -xdev -type f -size +200M -printf '%s %p\n' 2>/dev/null | sort -rn | head -10 | awk '{printf "%.1f GB  %s\n", $1/1073741824, $2}'
echo; echo "=== File đã xóa nhưng tiến trình còn giữ (chiếm ổ đĩa vô hình) ==="
if command -v lsof >/dev/null; then lsof -nP +L1 2>/dev/null | awk 'NR==1 || $7+0 > 52428800' | head -10; else echo "(cài lsof để kiểm tra: sudo apt-get install -y lsof)"; fi

if [ "${1:-}" = "--fix" ]; then
  echo; echo "=== Dọn phần an toàn ==="
  journalctl --vacuum-size=200M
  apt-get clean
  df -h /
fi
