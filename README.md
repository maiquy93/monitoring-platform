# Monitoring Platform

Ứng dụng theo dõi thiết bị mạng và máy chủ, có dashboard trạng thái, nhóm thiết bị,
sơ đồ topology, cảnh báo và tài khoản người dùng.

## 1. Cài đặt

1. Cài **Node.js 22 trở lên** trên máy chạy server.
2. Mở PowerShell tại thư mục dự án:

```powershell
cd C:\duong-dan\monitoring-platform
```

3. Dự án hiện không dùng thư viện ngoài, nên không cần `npm install`.

## 2. Chạy server

Đặt mật khẩu admin ban đầu rồi khởi động:

```powershell
$env:ADMIN_PASSWORD = "MatKhauBanDau-2026!"
npm start
```

Mặc định mở tại:

```text
http://localhost:8080
```

Có thể đổi cổng và vị trí database:

```powershell
$env:PORT = "8080"
$env:HOST = "0.0.0.0"
$env:DB_FILE = "C:\monitoring-data\monitor.db"
npm start
```

Nếu không đặt `ADMIN_PASSWORD`, server sẽ tự tạo mật khẩu ngẫu nhiên và in một lần
trong cửa sổ chạy server.

## 3. Đăng nhập lần đầu

1. Mở `http://localhost:8080`.
2. Đăng nhập bằng tài khoản `admin` và mật khẩu ban đầu.
3. Hệ thống bắt buộc đổi mật khẩu ở lần đăng nhập đầu tiên.
4. Sau đó vào **Cài đặt** để đặt tên hệ thống, mức cảnh báo và theme mặc định.

## 4. Chạy demo

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

## 5. Mở trên màn hình lớn

1. Mở hệ thống bằng Chrome hoặc Edge từ máy muốn trình chiếu.
2. Đăng nhập và chọn **Neon**, **Tối** hoặc **Sáng**.
3. Bấm nút màn hình lớn `📺` hoặc nhấn phím `F`.
4. Cho phép trình duyệt vào chế độ toàn màn hình.
5. Có thể bật nút luân phiên `🔁` để tự chuyển các màn hình.

Nếu truy cập từ máy khác, thay `localhost` bằng địa chỉ IP của máy chạy server và
đảm bảo cổng đã chọn được phép qua firewall.

## 6. Lưu ý khi dùng thật

Bản hiện tại phù hợp cho thử nghiệm nội bộ. Khi triển khai thật cần HTTPS/reverse
proxy, tài khoản vận hành riêng, backup database, SNMP community hoặc SNMPv3 phù
hợp, agent thật cho Linux/Windows và cấu hình thông báo bên ngoài.
