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
Restart=on-failure
RestartSec=5
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
khởi động bằng tài khoản `SYSTEM`. Log gọn nằm trong Task Scheduler; có thể
chạy thử runner để xem lỗi:

```powershell
Get-ScheduledTask -TaskName "Monitoring Platform Agent"
Get-Content "$env:ProgramData\Monitoring\agent.ps1"
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

## 5. Chạy demo và test

```powershell
npm test
node tools\seed-demo.js http://localhost:8080 admin MatKhauMoi
```

Demo tạo sẵn thiết bị, nhóm và topology. Agent thật dùng các lệnh ở mục 3;
`tools\simulate-agent.js` chỉ là công cụ giả lập để thử nhanh.

## 6. Màn hình lớn

Mở dashboard bằng Chrome/Edge, chọn theme Neon/Tối/Sáng, bấm nút `📺` hoặc phím
`F`, rồi bật `🔁` nếu muốn tự luân phiên dashboard, nhóm và topology.
