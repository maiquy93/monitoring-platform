# Monitoring Platform

Ứng dụng theo dõi thiết bị mạng và máy chủ, có dashboard trạng thái, nhóm thiết bị,
sơ đồ topology, cảnh báo và tài khoản người dùng.

## 1. Cài đặt trên Windows

### Chuẩn bị

1. Cài **Node.js 22 trở lên** từ trang chính thức của Node.js.
2. Mở PowerShell tại thư mục dự án:

```powershell
cd C:\duong-dan\monitoring-platform
```

3. Dự án hiện không dùng thư viện ngoài, nên không cần `npm install`.
4. Nếu muốn kiểm tra ICMP từ server, bảo đảm máy Windows có lệnh `ping` và
   Windows Firewall cho phép lưu lượng cần thiết.

### Chạy server trên Windows

Đặt mật khẩu admin ban đầu rồi khởi động trong PowerShell:

```powershell
$env:ADMIN_PASSWORD = "MatKhauBanDau-2026!"
$env:HOST = "0.0.0.0"
$env:PORT = "8080"
$env:DB_FILE = "C:\monitoring-data\monitor.db"
npm start
```

Tạo thư mục database trước nếu cần:

```powershell
New-Item -ItemType Directory -Force C:\monitoring-data
```

Mở `http://localhost:8080` trên chính máy server. Để truy cập từ máy khác,
cho phép TCP port `8080` trong Windows Firewall, ví dụ:

```powershell
New-NetFirewallRule -DisplayName "Monitoring Platform 8080" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080
```

Để chạy lâu dài trên Windows, nên dùng Task Scheduler hoặc một service manager
và chạy bằng tài khoản riêng, không nên chạy bằng tài khoản administrator thường
ngày. Không đóng cửa sổ PowerShell nếu đang chạy bằng `npm start` trực tiếp.

## 2. Cài đặt trên Linux không dùng Docker

Ví dụ dưới đây dành cho Ubuntu/Debian.

### Cài Node.js và công cụ ICMP

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl iputils-ping
```

Cài Node.js 22 trở lên theo cách quản trị chuẩn của máy chủ. Sau đó kiểm tra:

```bash
node --version
```

Tạo user và thư mục ứng dụng:

```bash
sudo useradd --system --create-home --home-dir /opt/monitoring monitoring
sudo mkdir -p /opt/monitoring/app /var/lib/monitoring
sudo chown -R monitoring:monitoring /opt/monitoring /var/lib/monitoring
```

Sao chép source vào `/opt/monitoring/app`, rồi kiểm tra:

```bash
cd /opt/monitoring/app
node --check server/index.js
```

### Chạy thử trên Linux

```bash
sudo -u monitoring env \
  ADMIN_PASSWORD='MatKhauBanDau-2026!' \
  HOST='0.0.0.0' \
  PORT='8080' \
  DB_FILE='/var/lib/monitoring/monitor.db' \
  node server/index.js
```

Kiểm tra từ máy server:

```bash
curl http://127.0.0.1:8080/api/health
```

Kết quả mong đợi:

```json
{"ok":true}
```

Mở firewall nếu hệ thống dùng UFW:

```bash
sudo ufw allow 8080/tcp
```

Khi dùng thật, nên tạo systemd service để server tự khởi động:

```ini
# /etc/systemd/system/monitoring.service
[Unit]
Description=Monitoring Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=monitoring
Group=monitoring
WorkingDirectory=/opt/monitoring/app
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=DB_FILE=/var/lib/monitoring/monitor.db
EnvironmentFile=-/etc/monitoring/monitoring.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Tạo file secret chỉ cho root đọc:

```bash
sudo mkdir -p /etc/monitoring
sudo sh -c 'printf "ADMIN_PASSWORD=%s\n" "MatKhauBanDau-2026!" > /etc/monitoring/monitoring.env'
sudo chmod 600 /etc/monitoring/monitoring.env
sudo systemctl daemon-reload
sudo systemctl enable --now monitoring.service
sudo systemctl status monitoring.service
```

Trong triển khai production, nên đặt Nginx hoặc Caddy phía trước để cấp HTTPS,
giữ server Node chỉ lắng nghe `127.0.0.1`.

## 3. Chạy trên Linux bằng Docker

Tạo `Dockerfile` tối thiểu trong thư mục dự án:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY tools ./tools
COPY README.md ./
ENV HOST=0.0.0.0
ENV PORT=8080
ENV DB_FILE=/data/monitor.db
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/index.js"]
```

Build và chạy:

```bash
docker build -t monitoring-platform .
docker volume create monitoring-data
docker run -d \
  --name monitoring \
  --restart unless-stopped \
  -p 8080:8080 \
  -e ADMIN_PASSWORD='MatKhauBanDau-2026!' \
  -v monitoring-data:/data \
  monitoring-platform
```

Kiểm tra:

```bash
curl http://127.0.0.1:8080/api/health
docker logs monitoring
```

Không dùng `--privileged` nếu chưa cần. Container cần kết nối mạng tới các thiết
bị được theo dõi; SNMP dùng UDP port `161`. ICMP trong container có thể bị giới
hạn bởi runtime hoặc chính sách kernel. Nếu `ping` trong container không hoạt động,
cần kiểm tra capability mạng của Docker trước khi cân nhắc cấp quyền bổ sung.

## 4. Đăng nhập lần đầu

1. Mở `http://localhost:8080`.
2. Đăng nhập bằng tài khoản `admin` và mật khẩu ban đầu.
3. Hệ thống bắt buộc đổi mật khẩu ở lần đăng nhập đầu tiên.
4. Sau đó vào **Cài đặt** để đặt tên hệ thống, mức cảnh báo và theme mặc định.

Nếu không đặt `ADMIN_PASSWORD`, server sẽ tự tạo mật khẩu ngẫu nhiên và in một lần
trong cửa sổ chạy server hoặc log container. Hãy đổi mật khẩu ngay sau lần đăng nhập
đầu tiên.

## 5. Cấu hình agent

### Trạng thái hiện tại

API agent đã có sẵn tại:

```text
POST /api/agent/report
Authorization: Bearer <agent-token>
Content-Type: application/json
```

Tuy nhiên repository hiện mới có `tools\simulate-agent.js`, là agent giả lập
Node.js để demo/test. Chưa có agent Linux thật hoặc Windows Service. Vì vậy các
hướng dẫn dưới đây mô tả cách cấu hình endpoint/token và cách chạy agent giả lập;
không nên xem đó là hướng dẫn cài agent production.

### Payload agent

Agent gửi JSON với các trường chính:

```json
{
  "hostname": "srv-web01",
  "os": "Linux",
  "agent_version": "0.1.0",
  "ip": "10.0.0.10",
  "cpu": { "percent": 32.5, "cores": 4, "load1": 0.8 },
  "memory": { "total": 8589934592, "used": 3221225472, "percent": 37.5 },
  "disks": [
    { "mount": "/", "total": 107374182400, "used": 42949672960, "percent": 40 }
  ],
  "uptime": 86400
}
```

Nếu server không nhận report trong khoảng mặc định `20 giây`, check agent được
đánh dấu lỗi. Có thể đổi bằng biến môi trường server:

```bash
AGENT_TIMEOUT_MS=20000
```

### Đăng ký agent tự động

Admin đặt `enroll_key` trong **Cài đặt**. Key phải có ít nhất 16 ký tự. Agent mới
gửi key này lần đầu, kèm `hostname`; server tạo thiết bị và trả về token riêng.
Sau đó agent phải dùng token riêng thay cho enroll key.

Không gửi enroll key hoặc agent token qua chat công khai, không ghi vào Git và nên
đổi token nếu nghi ngờ bị lộ. Có thể cấp lại token trong màn hình quản trị thiết bị.

### Agent giả lập trên Windows

Mở PowerShell tại thư mục dự án:

```powershell
node tools\simulate-agent.js `
  --server http://192.168.1.20:8080 `
  --token <agent-token> `
  --host srv-web01 `
  --interval 5 `
  --cpu 30
```

### Agent giả lập trên Linux

```bash
node tools/simulate-agent.js \
  --server http://192.168.1.20:8080 \
  --token '<agent-token>' \
  --host srv-linux01 \
  --interval 5 \
  --cpu 30
```

`--interval 5` nghĩa là gửi report khoảng mỗi 5 giây. Có thể dừng tiến trình để
kiểm tra cảnh báo timeout. Các giá trị CPU/RAM/disk của công cụ này là giả lập.

### Chuẩn bị cho agent thật

Khi phát triển agent production cho Linux hoặc Windows, cần cấu hình tối thiểu:

- URL API monitoring server.
- Token riêng của máy.
- Tên hostname và địa chỉ IP.
- Chu kỳ gửi report, khuyến nghị nhỏ hơn ngưỡng timeout.
- CA/TLS nếu server chạy HTTPS.
- Cơ chế retry/backoff khi mất mạng.
- Quyền đọc metric tối thiểu, không chạy quyền administrator/root nếu không cần.

## 6. Chạy demo

Khởi động server trước, sau đó mở PowerShell khác và chạy:

```powershell
node tools\seed-demo.js http://localhost:8080 admin MatKhauMoi
```

Lệnh này tạo một số thiết bị, nhóm và sơ đồ topology mẫu. Hai máy chủ demo dùng
agent giả lập; token được in ra sau khi seed.

Để gửi dữ liệu định kỳ từ agent giả lập:

```powershell
node tools\simulate-agent.js --server http://localhost:8080 --token <agent-token> --host srv-web01 --interval 5
```

Đây chỉ là dữ liệu mô phỏng, không phải agent Linux hoặc Windows thật.

## 7. Mở trên màn hình lớn

1. Mở hệ thống bằng Chrome hoặc Edge từ máy muốn trình chiếu.
2. Đăng nhập và chọn **Neon**, **Tối** hoặc **Sáng**.
3. Bấm nút màn hình lớn `📺` hoặc nhấn phím `F`.
4. Cho phép trình duyệt vào chế độ toàn màn hình.
5. Có thể bật nút luân phiên `🔁` để tự chuyển các màn hình.

Nếu truy cập từ máy khác, thay `localhost` bằng địa chỉ IP của máy chạy server và
đảm bảo cổng đã chọn được phép qua firewall.

## 8. Lưu ý khi dùng thật

Bản hiện tại phù hợp cho thử nghiệm nội bộ. Khi triển khai thật cần HTTPS/reverse
proxy, tài khoản vận hành riêng, backup database, SNMP community hoặc SNMPv3 phù
hợp, agent thật cho Linux/Windows và cấu hình thông báo bên ngoài.
