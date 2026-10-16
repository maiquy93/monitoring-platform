# Monitoring Platform

Nền tảng theo dõi nhẹ cho server, VM, thiết bị mạng và máy in trong mạng nội bộ.
Server chạy bằng Node.js, lưu dữ liệu trong SQLite và giao diện mở bằng trình duyệt.

## 1. Cài và chạy server

### Windows

1. Cài Node.js 22 trở lên.
2. Mở PowerShell tại thư mục source.
3. Chạy:

```powershell
New-Item -ItemType Directory -Force C:\monitoring-data
$env:ADMIN_PASSWORD = "MatKhauBanDau-2026!"
$env:HOST = "0.0.0.0"
$env:PORT = "8080"
$env:DB_FILE = "C:\monitoring-data\monitor.db"
# Không đặt COOKIE_SECURE khi dùng HTTP nội bộ
npm start
```

Cho phép TCP `8080` qua Windows Firewall nếu máy khác cần truy cập:

```powershell
New-NetFirewallRule -DisplayName "Monitoring Platform 8080" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080
```

### Linux

**Cách 1 — Triển khai tự động bằng một lệnh:**

```bash
sudo bash deploy/setup-os.sh
```

Script sẽ tự động cài các gói phụ thuộc (kể cả Node.js >= 22.5 nếu chưa có), tạo user `monitoring`, sao chép source vào `/opt/monitoring/app`, tạo cấu hình `/etc/monitoring/monitoring.env`, thiết lập systemd service `monitoring.service` tự khởi động khi boot OS và kiểm tra `/api/health`.

**Cách 2 — Cài đặt thủ công từng bước:**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl iputils-ping
sudo useradd --system --create-home --home-dir /opt/monitoring monitoring
sudo mkdir -p /opt/monitoring/app /var/lib/monitoring
sudo chown -R monitoring:monitoring /opt/monitoring /var/lib/monitoring
```

Chép source vào `/opt/monitoring/app`, sau đó chạy thử:

```bash
cd /opt/monitoring/app
sudo -u monitoring env ADMIN_PASSWORD='MatKhauBanDau-2026!' \
  HOST=0.0.0.0 PORT=8080 DB_FILE=/var/lib/monitoring/monitor.db \
  node server/index.js
```

Kiểm tra:

```bash
curl http://127.0.0.1:8080/api/health
```

Để tự khởi động cùng Linux, tạo `/etc/systemd/system/monitoring.service`:

```ini
[Unit]
Description=Monitoring Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=monitoring
Group=monitoring
WorkingDirectory=/opt/monitoring/app
Environment=HOST=0.0.0.0
Environment=PORT=8080
Environment=DB_FILE=/var/lib/monitoring/monitor.db
EnvironmentFile=-/etc/monitoring/monitoring.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /etc/monitoring
sudo sh -c 'printf "ADMIN_PASSWORD=%s\n" "MatKhauBanDau-2026!" > /etc/monitoring/monitoring.env'
sudo chmod 600 /etc/monitoring/monitoring.env
sudo systemctl daemon-reload
sudo systemctl enable --now monitoring.service
sudo systemctl status monitoring.service
```

Mạng nội bộ dùng HTTP trực tiếp `http://<IP-server>:8080`; không cần HTTPS,
Nginx, Caddy hay reverse proxy. Không đặt `COOKIE_SECURE` khi chạy HTTP.

### Cập nhật server bằng một lệnh

Trên máy phát triển: `git push`. Trên VM server:

```bash
sudo bash /opt/monitoring/app/deploy/update.sh
```

Script lấy bản mới (git), chạy test, áp cấu hình restart/journald, khởi động lại
dịch vụ, kiểm tra `/api/health` và tự quay về bản cũ nếu lỗi. Biết server đang
chạy bản nào: chân trang dashboard (`vX.Y.Z · mã xxxxxxxx`), trang **Cài đặt →
Hệ thống**, hoặc `curl http://127.0.0.1:8080/api/health` (trường `code`).

### Dung lượng ổ đĩa và tự dọn

Server tự xóa metrics quá hạn, giới hạn 100000 sự kiện, checkpoint WAL, và khi ổ
trống dưới 500 MB sẽ giữ lịch sử ngắn hơn. `deploy/monitoring-restart.conf` và
`deploy/journald-monitoring.conf` giới hạn tốc độ log và dung lượng journal
(`update.sh` tự cài). Kiểm tra bằng:

```bash
df -h /
sudo bash /opt/monitoring/app/deploy/disk-report.sh          # chỉ báo cáo
sudo bash /opt/monitoring/app/deploy/disk-report.sh --fix    # dọn journal/apt
```

### Docker (tùy chọn)

Chạy trực tiếp bằng Node được khuyến nghị. Nếu dùng Docker, cần mount thư mục
database và mở cổng:

```bash
docker build -t monitoring-platform .
docker volume create monitoring-data
docker run -d --name monitoring --restart unless-stopped \
  -p 8080:8080 -e ADMIN_PASSWORD='MatKhauBanDau-2026!' \
  -v monitoring-data:/data monitoring-platform
```

## 2. Đăng nhập và cấu hình lần đầu

Mở `http://localhost:8080`, đăng nhập bằng `admin` và mật khẩu
`ADMIN_PASSWORD`. Hệ thống bắt buộc đổi mật khẩu lần đầu.

Vào **Cài đặt → Đăng ký agent tự động**, bấm **Tạo ngẫu nhiên** rồi lưu một
enroll key dài ít nhất 16 ký tự. Không đưa key vào Git hoặc gửi công khai.

## 3. Cài agent thật cho máy cần giám sát

Agent không cần cài Node.js, Python hay thư viện ngoài. Agent dùng công cụ có
sẵn của hệ điều hành, gửi JSON mỗi 5 giây và tự retry khi mất mạng với backoff
tối đa 30 giây. Server tạo thiết bị tự động từ enroll key; không cần tạo thủ công.

Trong giao diện **Thiết bị → Thêm máy mới**, admin có sẵn lệnh đúng địa chỉ
server và nút **Sao chép**.

### Linux

Chạy trên máy Linux:

```bash
curl -fsSL http://<IP-server>:8080/agent/install.sh | sudo bash -s -- --key '<enroll-key>'
```

Agent chạy bằng systemd, tự khởi động và tự chạy lại:

```bash
sudo systemctl status monitoring-agent
sudo journalctl -u monitoring-agent -f
```

Gỡ cài đặt:

```bash
curl -fsSL http://<IP-server>:8080/agent/install.sh | \
  sudo bash -s -- --uninstall
```

Agent đọc hostname, `/proc/stat`, `/proc/meminfo`, `df`, uptime và gửi
`os: "Linux"`.

### Windows PowerShell 5.1

Mở **Windows PowerShell bằng quyền Administrator**, dán một dòng:

```powershell
& ([scriptblock]::Create((irm http://<IP-server>:8080/agent/install.ps1))) -Key '<enroll-key>' -Server 'http://<IP-server>:8080'
```

Agent dùng `Get-CimInstance`, `Get-NetIPAddress` và Scheduled Task chạy lúc
khởi động bằng tài khoản `SYSTEM`; task được khởi chạy ngay sau khi cài, không
giới hạn thời gian chạy và tự restart khi lỗi. Config được nạp bằng
`[scriptblock]::Create` để tương thích Windows PowerShell 5.1. Kiểm tra:

```powershell
Get-ScheduledTask -TaskName "Monitoring Platform Agent" | Get-ScheduledTaskInfo
```

Chạy thử runner để xem lỗi (dừng task trước để tránh chạy trùng):

```powershell
Stop-ScheduledTask -TaskName "Monitoring Platform Agent"
& "$env:ProgramData\Monitoring\agent.ps1"
```

Gỡ cài đặt bằng PowerShell Administrator:

```powershell
& ([scriptblock]::Create((irm http://<IP-server>:8080/agent/install.ps1))) -Uninstall
```

Agent gửi `os: "Windows"`.

### macOS Intel và Apple Silicon

Mở Terminal:

```bash
curl -fsSL http://<IP-server>:8080/agent/install-macos.sh | \
  sudo bash -s -- --key '<enroll-key>'
```

Agent chạy bằng LaunchDaemon, dùng `sysctl`, `vm_stat`, `top -l 1` và `df`:

```bash
sudo launchctl print system/com.monitoring.agent
sudo log stream --predicate 'process == "monitoring-agent"'
```

Gỡ cài đặt:

```bash
curl -fsSL http://<IP-server>:8080/agent/install-macos.sh | \
  sudo bash -s -- --uninstall
```

Agent gửi `os: "macOS"` và hỗ trợ cả Intel lẫn Apple Silicon.

### Payload agent

```json
{
  "hostname": "srv-web01",
  "os": "Linux",
  "agent_version": "1.0.0",
  "ip": "10.0.0.10",
  "cpu": { "percent": 32.5, "cores": 4, "load1": 0.8 },
  "memory": { "total": 8589934592, "used": 3221225472, "percent": 37.5 },
  "disks": [
    { "mount": "/", "total": 107374182400, "used": 42949672960, "percent": 40 }
  ],
  "uptime": 86400
}
```

### Nếu agent không xuất hiện

1. Kiểm tra máy agent truy cập được `http://<IP-server>:8080`.
2. Kiểm tra enroll key còn đúng và dài tối thiểu 16 ký tự.
3. Kiểm tra log theo hệ điều hành ở các lệnh trên.
4. Kiểm tra dashboard và **Sự kiện**; agent quá 20 giây không gửi sẽ thành
   cảnh báo hoặc mất kết nối theo trạng thái ICMP.
5. Kiểm tra firewall TCP từ máy agent tới server.

## 4. Chuẩn bị SNMP

Trên router, switch, firewall hoặc máy in: bật SNMP v2c, tạo community riêng,
chỉ cho IP server truy cập, quyền read-only và UDP port 161. Không dùng
community `public`. Sau đó vào **Thiết bị**, nhập IP, bật SNMP và nhập community.

Với SNMP, server tự nhận diện thiết bị (sysObjectID + sysDescr), chọn một
**hồ sơ thiết bị** trong `server/profiles/` rồi đọc CPU, RAM, ổ đĩa, nhiệt độ
và chỉ số riêng của hãng. Không khớp hãng nào thì dùng hồ sơ chung
(HOST-RESOURCES, có dự phòng UCD-SNMP và Printer-MIB cho máy in).
Thiết bị không cần cài agent.

Trên trang chi tiết thiết bị: xem hồ sơ đang dùng, admin đổi tay nếu nhận
diện sai, chỉ số nào không đọc được sẽ hiện kèm lý do (timeout/sai community,
OID không tồn tại, không có dòng dữ liệu...). Nút **Xuất dữ liệu SNMP** tải
file `.walk` để gửi cho người phát triển khi gặp thiết bị chưa hỗ trợ.

**MikroTik RouterOS:**

```
/snmp set enabled=yes
/snmp community set [find default=yes] name=<community> addresses=<IP-server>/32
```

Sau đó sửa thiết bị trên dashboard, tick **Giám sát SNMP**, nhập đúng community.

**Fortinet FortiGate (FortiOS):** chọn **Tự nhận diện** là đủ (sysObjectID
`1.3.6.1.4.1.12356` hoặc sysDescr chứa `FortiGate`/`FortiOS`). FortiOS không
dùng HOST-RESOURCES nên hồ sơ `fortigate` đọc FORTINET-FORTIGATE-MIB:
CPU `…12356.101.4.1.3.0`, RAM `…4.1.4.0`, ổ đĩa `…4.1.6.0`/`…4.1.7.0` (MB), phiên bản
`…4.1.1.0`, số session `…4.1.8.0`. Các OID này lấy từ MIB công bố của Fortinet,
**chưa kiểm chứng bằng walk thật** (giao diện ghi "chưa kiểm chứng"). Trên FortiGate:

```
config system snmp sysinfo
  set status enable
end
config system snmp community
  edit 1
    set name <community>
    config hosts
      edit 1
        set ip <IP-server> 255.255.255.255
      next
    end
  next
end
config system interface
  edit <interface-nối-tới-server>
    append allowaccess snmp
  next
end
```


**Cisco IOS / IOS-XE (switch, router):** chọn **Tự nhận diện** (sysObjectID
`1.3.6.1.4.1.9` hoặc sysDescr chứa `Cisco IOS`). Hồ sơ `cisco` đọc CPU từ
`cpmCPUTotal5minRev` (`1.3.6.1.4.1.9.9.109.1.1.1.1.8`, CISCO-PROCESS-MIB, lấy CPU cao nhất)
và RAM từ `ciscoMemoryPoolUsed`/`ciscoMemoryPoolFree` (`1.3.6.1.4.1.9.9.48.1.1.1.5`/`.6`,
CISCO-MEMORY-POOL-MIB, pool Processor). Không có chỉ số ổ đĩa. Nguồn: MIB công bố của Cisco
(`github.com/cisco/cisco-mibs`), **chưa kiểm chứng bằng walk thật**. Gauge32 nên RAM > 4 GB có thể sai. Trên thiết bị:

```
snmp-server community <community> RO <ACL-cho-IP-server>
```

**pfSense / OPNsense:** chọn **Tự nhận diện** (sysObjectID `1.3.6.1.4.1.12325` của bsnmpd,
hoặc sysDescr chứa `pfSense`/`OPNsense` khi dùng net-snmp). Hồ sơ `pfsense` đọc CPU/RAM từ
UCD-SNMP-MIB (`ssCpuIdle` `…2021.11.11.0`, `memTotalReal` `…2021.4.5.0`, `memAvailReal` `…2021.4.6.0`)
và ổ đĩa từ HOST-RESOURCES-MIB (`hrStorageTable`). bsnmpd mặc định không có UCD-SNMP-MIB nên
CPU/RAM tự dùng HOST-RESOURCES dự phòng. **Chưa kiểm chứng bằng walk thật.**
Bật SNMP ở pfSense: Services > SNMP; OPNsense: Services > Net-SNMP (plugin `os-net-snmp`).

**Synology NAS (DSM):** chọn **Tự nhận diện** (sysObjectID `1.3.6.1.4.1.6574` hoặc sysDescr chứa
`Synology`/`DiskStation`). Theo *Synology DiskStation MIB Guide*: CPU `cpuUtilization`
(`1.3.6.1.4.1.6574.1.7.1.0`), RAM `memUtilization` (`…6574.1.7.2.0`), nhiệt độ `…6574.1.2.0`
(SYNOLOGY-SYSTEM-MIB); dung lượng từ SYNOLOGY-RAID-MIB (`raidFreeSize`/`raidTotalSize`,
`…6574.3.1.1.4`/`.5`, lấy volume đầy nhất) vì MIB hệ thống/đĩa của Synology không có chỉ số dùng
đĩa. DSM cũ thiếu các OID này sẽ dùng UCD-SNMP-MIB / HOST-RESOURCES dự phòng.
**Chưa kiểm chứng bằng walk thật.** Bật SNMP: Control Panel > Terminal & SNMP > SNMP.

Chẩn đoán (walk thiết bị thật, lưu `test/fixtures/<hãng>-<model>.walk`, rồi in
hồ sơ được chọn và từng chỉ số):

```bash
node tools/snmp-probe.js <IP> <community> --name <hãng>-<model>
```

### Cách thêm hồ sơ cho một hãng mới

Không sửa code, chỉ thêm file và test:

1. Walk thiết bị thật bằng lệnh `snmp-probe` ở trên (hoặc nhận file `.walk` từ
   nút **Xuất dữ liệu SNMP**) và đặt vào `test/fixtures/`. File có thể chứa
   IP/MAC/serial của mạng bên cạnh, không chứa community.
2. Tạo `server/profiles/<id>.json` (id trùng tên file):

```json
{
  "id": "vi-du", "name": "Hãng Ví dụ",
  "match": { "sysObjectID": ["1.3.6.1.4.1.12345"], "sysDescr": "regex tuỳ chọn" },
  "priority": 10,
  "extends": "generic",
  "verified_with": ["vi-du-model-x"],
  "metrics": {
    "cpu": { "unit": "%", "sources": [
      { "get": "1.3.6.1.4.1.12345.1.0" },
      { "percent": { "used": "…", "total": "…" } },
      { "table": { "columns": { "d": "…" }, "value": { "column": "d" }, "agg": "avg" } }
    ] },
    "fan": { "optional": true, "sources": [{ "get": "…", "map": { "1": "ok" }, "text": true }] }
  }
}
```

   - Mỗi chỉ số có danh sách `sources` thử lần lượt; nguồn đầu đọc được thì dừng.
   - Nguồn: `get` (một OID), `percent` (`used` hoặc `free`, cùng `total`), `table`
     (`columns`, `where`, `value.column` hoặc `value.percent`, `agg` = avg/max/min/sum/first); `value.percent` dùng `total` + `used`/`free`, hoặc cả `used` và `free` khi MIB không có cột tổng).
   - Tuỳ chọn: `scale`, `invert`, `map`, `text`, `unverified`, `optional`; `round`, `unit` ở cấp chỉ số.
   - Chỉ số lõi: `cpu`, `ram`, `disk`, `temperature`, `toner`, `uptime`; tên khác hiện ở mục chỉ số riêng.
   - `extends` kế thừa chỉ số; đặt `"tên": null` để bỏ chỉ số kế thừa.
3. Thêm test với file `.walk` thật (xem `test/snmp-profiles.test.js`).
   Bài test chung sẽ báo lỗi nếu `verified_with` thiếu hoặc không đọc được CPU/RAM/Disk.
4. **Không đoán OID từ trí nhớ.** Chưa có dữ liệu thật thì đánh dấu
   `"unverified": true` (giao diện sẽ ghi "chưa kiểm chứng").
5. Khởi động lại server để nạp hồ sơ.

## 5. Chạy demo và test

```powershell
npm test
node tools\seed-demo.js http://localhost:8080 admin MatKhauMoi
```

Demo tạo sẵn thiết bị, nhóm và topology. Agent thật dùng các lệnh ở mục 3;
`tools\simulate-agent.js` chỉ là công cụ giả lập để thử nhanh.

## 6. Màn hình lớn, Màn hình đôi, Cảnh báo liên tục & Đa ngôn ngữ

- **Màn hình lớn (TV / Wallboard):** Mở dashboard bằng Chrome/Edge, chọn theme Neon/Tối/Sáng, bấm nút `📺` hoặc phím `F`, rồi bật `🔁` nếu muốn tự luân phiên dashboard, nhóm và topology.
- **Màn hình đôi (Dual-Screen):** Bấm nút `🖥️` hoặc phím `D` để chia đôi màn hình hoặc mở cửa sổ phụ (`#/secondary`) sang màn hình thứ 2. Thẻ tổng quan được ghim cố định, danh sách thiết bị cuộn độc lập với thanh cuộn mảnh thẩm mỹ.
- **Chuông cảnh báo toàn cục liên tục (Continuous Global Alarm):** Khi bật biểu tượng chuông `🔔` trên thanh công cụ, bất kỳ sự cố chưa xác nhận nào thuộc thiết bị có mức cảnh báo **Nghiêm trọng (Critical)** hoặc **Cao (High)** (hoặc cảnh báo khẩn cấp phần cứng/DoS/nhiệt độ/UPS) sẽ kích hoạt chuông báo động kêu liên tục mỗi 3.5 giây kèm hiệu ứng rung chuông đỏ cho đến khi người vận hành bấm nút **Đã biết (Acknowledge)**.
- **Đa ngôn ngữ (Tiếng Việt / English):** Chọn nhanh ngôn ngữ `🇻🇳 VI` / `🇬🇧 EN` trên thanh header hoặc thiết lập ngôn ngữ mặc định cho toàn hệ thống trong **Cài đặt → Chung → Ngôn ngữ mặc định**.

---

# Monitoring Platform (English Documentation)

A lightweight, self-hosted internal network monitoring platform for servers, virtual machines (VMs), network equipment (routers, switches, firewalls, wireless APs), and printers.
Powered by Node.js, built-in SQLite (`node:sqlite`), and a zero-dependency real-time web interface.

## 1. Server Installation & Startup

### Windows

1. Install Node.js 22 or newer.
2. Open PowerShell in the source directory.
3. Run:

```powershell
New-Item -ItemType Directory -Force C:\monitoring-data
$env:ADMIN_PASSWORD = "InitialPassword-2026!"
$env:HOST = "0.0.0.0"
$env:PORT = "8080"
$env:DB_FILE = "C:\monitoring-data\monitor.db"
# Do not set COOKIE_SECURE when running over internal HTTP
npm start
```

Allow TCP port `8080` through Windows Firewall if other machines need access:

```powershell
New-NetFirewallRule -DisplayName "Monitoring Platform 8080" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080
```

### Linux

**Option 1 — Automated One-Command Deployment:**

```bash
sudo bash deploy/setup-os.sh
```

This script automatically installs required dependencies (including Node.js >= 22.5 if missing), creates the `monitoring` system user, copies source files to `/opt/monitoring/app`, generates `/etc/monitoring/monitoring.env`, configures and enables the `monitoring.service` systemd unit on boot, and verifies `/api/health`.

**Option 2 — Manual Step-by-Step Installation:**

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl iputils-ping
sudo useradd --system --create-home --home-dir /opt/monitoring monitoring
sudo mkdir -p /opt/monitoring/app /var/lib/monitoring
sudo chown -R monitoring:monitoring /opt/monitoring /var/lib/monitoring
```

Copy the source code into `/opt/monitoring/app`, then test run:

```bash
cd /opt/monitoring/app
sudo -u monitoring env ADMIN_PASSWORD='InitialPassword-2026!' \
  HOST=0.0.0.0 PORT=8080 DB_FILE=/var/lib/monitoring/monitor.db \
  node server/index.js
```

Verify health endpoint:

```bash
curl http://127.0.0.1:8080/api/health
```

To start automatically on Linux boot, create `/etc/systemd/system/monitoring.service`:

```ini
[Unit]
Description=Monitoring Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=monitoring
Group=monitoring
WorkingDirectory=/opt/monitoring/app
Environment=HOST=0.0.0.0
Environment=PORT=8080
Environment=DB_FILE=/var/lib/monitoring/monitor.db
EnvironmentFile=-/etc/monitoring/monitoring.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /etc/monitoring
sudo sh -c 'printf "ADMIN_PASSWORD=%s\n" "InitialPassword-2026!" > /etc/monitoring/monitoring.env'
sudo chmod 600 /etc/monitoring/monitoring.env
sudo systemctl daemon-reload
sudo systemctl enable --now monitoring.service
sudo systemctl status monitoring.service
```

For internal LAN deployments, access HTTP directly at `http://<server-IP>:8080`; no HTTPS, Nginx, Caddy, or reverse proxy is required. Do not set `COOKIE_SECURE` when running over plain HTTP.

### One-Command Server Update

On your development machine: `git push`. On the server VM:

```bash
sudo bash /opt/monitoring/app/deploy/update.sh
```

The script pulls the latest git commit, runs automated tests, applies restart/journald limits, restarts the service, checks `/api/health`, and automatically rolls back to the previous commit if any check fails. You can inspect the running version in the dashboard footer (`vX.Y.Z · commit xxxxxxxx`), under **Settings → System**, or via `curl http://127.0.0.1:8080/api/health` (`code` field).

### Disk Space & Auto-Cleanup

The server automatically prunes expired metrics, caps the event log at 100,000 rows, checkpoints the SQLite WAL file, and shortens retention automatically if free disk space drops below 500 MB. `deploy/monitoring-restart.conf` and `deploy/journald-monitoring.conf` cap log rate and systemd journal size (automatically installed by `update.sh`). Check disk status with:

```bash
df -h /
sudo bash /opt/monitoring/app/deploy/disk-report.sh          # report only
sudo bash /opt/monitoring/app/deploy/disk-report.sh --fix    # clean journal/apt cache
```

### Docker (Optional)

Running directly on Node.js is recommended. If using Docker, mount a persistent volume for `/data` and expose port `8080`:

```bash
docker build -t monitoring-platform .
docker volume create monitoring-data
docker run -d --name monitoring --restart unless-stopped \
  -p 8080:8080 -e ADMIN_PASSWORD='InitialPassword-2026!' \
  -v monitoring-data:/data monitoring-platform
```

## 2. First Login & Initial Configuration

Open `http://localhost:8080` and sign in with username `admin` and your `ADMIN_PASSWORD`. You will be prompted to change your password on first login.

### Language Settings (Vietnamese / English)
- **Quick Switch:** Use the `🇻🇳 VI` / `🇬🇧 EN` selector in the top navigation bar to switch the interface language immediately without reloading or disrupting live WebSocket/SSE streams. Your personal preference is saved to your user account and synced across dual-screen windows.
- **System Default Language:** Admins can go to **Settings → General → Default Language** to set the default language (`Tiếng Việt` or `English`) for the entire organization.

### Auto Agent Enrollment Key
Go to **Settings → Auto Agent Enrollment**, click **Generate Random**, and save an enroll key of at least 16 characters. Keep this key confidential and never commit it to Git.

## 3. Installing Monitoring Agents on Target Machines

Agents require zero external dependencies (no Node.js, Python, or third-party packages needed on monitored hosts). They use built-in OS utilities, report JSON metrics every 5 seconds, and automatically retry with exponential backoff (up to 30s) during network outages. Devices are auto-created on first report using the enroll key.

In **Devices → + Install Agent**, admins can copy pre-filled installation commands containing the exact server URL and enroll key.

### Linux

Run on the target Linux host:

```bash
curl -fsSL http://<server-IP>:8080/agent/install.sh | sudo bash -s -- --key '<enroll-key>'
```

The agent runs as a `systemd` service (`monitoring-agent`), starts on boot, and auto-restarts on failure:

```bash
sudo systemctl status monitoring-agent
sudo journalctl -u monitoring-agent -f
```

Uninstall:

```bash
curl -fsSL http://<server-IP>:8080/agent/install.sh | \
  sudo bash -s -- --uninstall
```

### Windows PowerShell 5.1+

Open **Windows PowerShell as Administrator** and run:

```powershell
& ([scriptblock]::Create((irm http://<server-IP>:8080/agent/install.ps1))) -Key '<enroll-key>' -Server 'http://<server-IP>:8080'
```

The agent uses `Get-CimInstance` and `Get-NetIPAddress`, registered as a Windows Scheduled Task running as `SYSTEM` at startup. Verify status:

```powershell
Get-ScheduledTask -TaskName "Monitoring Platform Agent" | Get-ScheduledTaskInfo
```

Uninstall (PowerShell as Administrator):

```powershell
& ([scriptblock]::Create((irm http://<server-IP>:8080/agent/install.ps1))) -Uninstall
```

### macOS (Intel & Apple Silicon)

Open Terminal and run:

```bash
curl -fsSL http://<server-IP>:8080/agent/install-macos.sh | \
  sudo bash -s -- --key '<enroll-key>'
```

The agent runs as a `LaunchDaemon` (`com.monitoring.agent`) using `sysctl`, `vm_stat`, `top -l 1`, and `df`.

Uninstall:

```bash
curl -fsSL http://<server-IP>:8080/agent/install-macos.sh | \
  sudo bash -s -- --uninstall
```

## 4. SNMP Monitoring & Vendor Profiles

On routers, switches, firewalls, wireless APs, or network printers: enable SNMP v2c, create a read-only community string restricted to the monitoring server's IP on UDP port 161 (avoid using `public` in production). Then go to **Devices**, add or edit the device, enable **SNMP Monitoring**, and enter the community string.

The server automatically identifies the device via `sysObjectID` and `sysDescr`, selects a matching profile from `server/profiles/` (e.g., MikroTik RouterOS, Fortinet FortiGate, Cisco IOS/IOS-XE, pfSense/OPNsense, Synology DSM, or generic HOST-RESOURCES / UCD-SNMP / Printer-MIB), and polls CPU, RAM, storage, temperature, wireless SSIDs/clients, and printer supplies (toner, drum, paper trays, page count).

On any device detail page, admins can manually override the SNMP profile or click **Export SNMP Walk** to download a `.walk` diagnostic file for adding new vendor support.

## 5. Global Continuous Alarm, Dual-Screen & TV Wallboard

- **Continuous Global Alarm (Critical & High Severity):**
  - Enable sound alerts by clicking the `🔔` button in the top toolbar.
  - When any device configured with **Critical** or **High** alert severity enters an unacknowledged **Disconnected (`down`)** or **Warning (`warning`)** state (or triggers an emergency hardware/DoS/thermal/UPS alert), the alarm bell rings continuously every 3.5 seconds and pulses red in the header.
  - The alarm continues ringing until an operator clicks the **Acknowledge (`Đã biết`)** button on the global alert banner or inside the device detail page.
- **Dual-Screen Mode (Key `D`):**
  - Press `D` or click `🖥️` to split the dashboard into a primary device monitoring view (with pinned KPI summary cards and an independent sleek scrollable device grid) alongside a secondary Topology / Groups / Live Alerts panel, or pop out `#/secondary` onto a second physical monitor.
- **Fullscreen Wallboard & Auto-Rotate (Key `F`):**
  - Press `F` or click `📺` for fullscreen NOC wallboard mode, and click `🔁` to auto-rotate across Overview, Groups, and Topology maps (automatically pausing on Overview whenever an active alert occurs).

## 6. Running Tests & Demo Seed

```bash
npm test
node tools/seed-demo.js http://localhost:8080 admin YourAdminPassword
```

