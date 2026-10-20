'use strict';
// Core: state, API, shell, realtime, routing, helpers, i18n, continuous alarm. Views register themselves on M.views.
const M = window.M = {
  S: {
    user: null, settings: null, snap: null, groups: [], maps: [],
    sound: localStorage.getItem('sound') === '1',
    tv: false, rotate: false,
    dual: localStorage.getItem('dual_screen') === '1',
    lang: localStorage.getItem('lang') || 'vi',
    lastSnapAt: 0,
  },
  views: {},
};

const I18N_EN = {
  // Navigation & Shell
  'Tổng quan': 'Overview',
  'Nhóm': 'Groups',
  'Sơ đồ': 'Topology',
  'Sự kiện': 'Events',
  'Thiết bị': 'Devices',
  'Cài đặt': 'Settings',
  'Âm thanh cảnh báo': 'Alert sound (Continuous alarm for Critical/High until Acknowledged)',
  'Tự động luân phiên màn hình (chế độ TV)': 'Auto-rotate screens (TV mode)',
  'Chế độ màn hình đôi (Phím D): Chia 2 màn hình hoặc mở cửa sổ phụ': 'Dual-screen mode (Key D): Split view or popout secondary window',
  'Chế độ màn hình lớn (phím F)': 'Wall / TV fullscreen mode (Key F)',
  'Ngôn ngữ hiển thị': 'Display language',
  'Giao diện': 'Theme',
  'Tối': 'Dark',
  'Sáng': 'Light',
  'Đổi mật khẩu': 'Change password',
  'Đăng xuất': 'Log out',
  'Đã biết': 'Acknowledge',
  'Bật tự động luân phiên (dừng ở Tổng quan khi có cảnh báo)': 'Auto-rotate enabled (pauses on Overview during alerts)',
  'Tắt luân phiên': 'Auto-rotate disabled',
  'Bật chế độ màn hình đôi (Phím D)': 'Dual-screen mode enabled (Key D)',
  'Tắt chế độ màn hình đôi': 'Dual-screen mode disabled',
  '⚠ Mất kết nối tới máy chủ giám sát – dữ liệu hiển thị có thể đã cũ': '⚠ Lost connection to monitoring server – displayed data may be stale',
  'Mất kết nối': 'Disconnected',
  'Cảnh báo': 'Warning',
  'Online': 'Online',
  'Chưa rõ': 'Unknown',
  'Bảo trì': 'Maintenance',

  // Device types & severities
  'Máy chủ': 'Server',
  'Máy ảo (VM)': 'Virtual Machine (VM)',
  'Router': 'Router',
  'Switch': 'Switch',
  'Firewall': 'Firewall',
  'Access Point': 'Access Point',
  'Máy in': 'Printer',
  'UPS': 'UPS',
  'Máy trạm': 'Workstation / PC',
  'Khác': 'Other',
  'Nghiêm trọng': 'Critical',
  'Cao': 'High',
  'Trung bình': 'Medium',
  'Thấp': 'Low',
  'Không cảnh báo': 'No alert',

  // Login & Modals
  'Tên đăng nhập': 'Username',
  'Mật khẩu': 'Password',
  'Đăng nhập': 'Sign in',
  'Bạn cần đổi mật khẩu trước khi sử dụng': 'You must change your password before continuing',
  'Mật khẩu hiện tại': 'Current password',
  'Mật khẩu mới (tối thiểu 8 ký tự)': 'New password (min 8 characters)',
  'Nhập lại mật khẩu mới': 'Confirm new password',
  'Mật khẩu nhập lại không khớp': 'Passwords do not match',
  'Đã đổi mật khẩu': 'Password changed successfully',
  'Xác nhận': 'Confirm',
  'Đồng ý': 'Confirm',
  'Hủy': 'Cancel',
  'Lưu': 'Save',
  'Đóng': 'Close',
  'Tạo': 'Create',
  'Sửa': 'Edit',
  'Xóa': 'Delete',
  'Đã lưu': 'Saved successfully',

  // Dashboard & Dual Screen
  'Thiết bị đang hoạt động': 'Active Devices',
  'Chưa rõ / Bảo trì': 'Unknown / Maint.',
  '🔍 Chi tiết': '🔍 Details',
  'Bấm để xem danh sách thiết bị đang hoạt động': 'Click to view active devices',
  'Bấm để xem danh sách thiết bị mất kết nối': 'Click to view disconnected devices',
  'Bấm để xem danh sách chi tiết các cảnh báo': 'Click to view detailed active warnings',
  'Bấm để xem thiết bị chưa rõ hoặc đang bảo trì': 'Click to view unknown or maintenance devices',
  'Nhóm thiết bị': 'Device Groups',
  'Tìm thiết bị…': 'Search devices…',
  'Tất cả trạng thái': 'All statuses',
  'Chỉ có vấn đề': 'Problems only',
  'Mọi loại': 'All types',
  'Không có thiết bị phù hợp': 'No matching devices found',
  'Chưa có thiết bị nào. Vào mục "Thiết bị" để thêm.': 'No devices yet. Go to "Devices" to add one.',
  '🖥️ Màn hình 2': '🖥️ Screen 2',
  '🗺️ Topology': '🗺️ Topology',
  '🗂️ Nhóm': '🗂️ Groups',
  '⚠️ Cảnh báo': '⚠️ Alerts',
  '🗗 Cửa sổ riêng': '🗗 Popout',
  'Mở cửa sổ tách biệt cho màn hình phụ thứ hai': 'Open detached window for secondary monitor',
  'Tắt chế độ màn hình đôi': 'Close dual-screen mode',
  'Chưa có sơ đồ mạng Topology': 'No Topology Map Yet',
  'Tạo sơ đồ mạng để theo dõi trực quan liên kết giữa các thiết bị trên màn hình thứ hai.': 'Create a network topology map to visually monitor device links on the second screen.',
  '+ Tạo sơ đồ Topology': '+ Create Topology Map',
  'Chưa có nhóm thiết bị nào.': 'No device groups yet.',
  'Hệ thống đang hoạt động ổn định': 'System is operating normally',
  'Tất cả thiết bị đều đang trực tuyến, không có cảnh báo.': 'All devices are online with no active alerts.',
  '◉ MÀN HÌNH PHỤ (SECONDARY)': '◉ SECONDARY SCREEN',
  '🗺️ Sơ đồ Topology': '🗺️ Topology Map',
  '📊 Wallboard': '📊 Wallboard',
  'Phóng to toàn màn hình (phím F)': 'Toggle fullscreen (Key F)',
  '📺 Toàn màn hình': '📺 Fullscreen',
  'Chưa có sơ đồ Topology nào.': 'No Topology map available.',
  '✅ Tất cả thiết bị đang hoạt động ổn định': '✅ All devices are operating normally',

  // Tiles & Common Widgets
  'Đang bảo trì (tắt cảnh báo)': 'Under maintenance (alerts muted)',
  'Chưa có dữ liệu': 'No data yet',
  'Ổn định': 'Healthy',
  'Trống': 'Empty',
  'cảnh báo': 'warning',
  'Mực': 'Toner',
  'trang': 'pages',
  'Tổng số lượng SSID phát sóng và Client kết nối': 'Total broadcasting SSIDs and connected Clients',
  'Hộp mực tích hợp (all-in-one) hoặc không có cảm biến drum riêng': 'All-in-one cartridge or no dedicated drum sensor',
  'Không đọc được dữ liệu mức mực': 'Unable to read toner level',
  'Môi trường máy ảo (VM) hoặc phần cứng không có cảm biến nhiệt': 'Virtual Machine (VM) or hardware without thermal sensor',
  '💾 Lỗi đĩa': '💾 Disk Error',
  '🔋 Mất điện': '🔋 On Battery',
  'Sự cố máy in': 'Printer Issue',
  'Báo động nhiệt độ CPU quá cao (Thermal Throttling)': 'CPU Thermal Throttling Alert',
  'Chưa đủ dữ liệu lịch sử': 'Not enough historical data yet',
  'Chưa có sự kiện': 'No events recorded',
  'Thời gian': 'Time',
  'Loại': 'Type',
  'Nội dung': 'Message',
  'Phục hồi': 'Recovered',
  'Hệ thống': 'System',
  'Tấn công DoS': 'DoS Attack',
  'Lỗi đĩa cứng': 'Disk SMART Error',
  'Quá nhiệt': 'Thermal Alert',
  'Mất điện lưới': 'Power Loss',

  // Groups View
  'Nhóm / cụm thiết bị': 'Device Groups / Clusters',
  '+ Thêm nhóm': '+ Add Group',
  'Chưa có nhóm. Nhóm giúp gom các thiết bị (ví dụ: Tầng 1, Cụm DB) để theo dõi riêng.': 'No groups yet. Groups let you organize devices (e.g., Floor 1, DB Cluster) for dedicated monitoring.',
  'Không tìm thấy nhóm': 'Group not found',
  'Thiết bị trong nhóm': 'Devices in Group',
  'Sửa nhóm': 'Edit Group',
  'Thêm nhóm': 'Add Group',
  'Tên nhóm *': 'Group Name *',
  'Mô tả': 'Description',
  'Xóa nhóm': 'Delete Group',
  'Đã lưu nhóm': 'Group saved',
  'Nhóm chưa có thiết bị cài agent': 'No agent-enabled devices in this group',
  'Nhóm chưa có thiết bị': 'No devices in this group',
  'trung bình': 'average',

  // Device Detail View
  'Lịch sử': 'History',
  'Lịch sử giám sát': 'Monitoring History',
  'Thời gian thực': 'Realtime',
  'Tải xuống': 'Download',
  'Tải lên': 'Upload',
  'Cao nhất': 'Max',
  'Ổ đĩa': 'Disk',
  'Độ trễ': 'Latency',
  '1 giờ': '1 hour',
  '6 giờ': '6 hours',
  '24 giờ': '24 hours',
  '7 ngày': '7 days',
  '30 ngày': '30 days',
  '90 ngày': '90 days',
  'Sự kiện gần đây': 'Recent Events',
  'Kết thúc bảo trì': 'End Maintenance',
  '← Quay lại': '← Back',
  'Độ bền Drum': 'Drum Life',
  'Tích hợp': 'Integrated',
  'Lượng mực in': 'Toner Level',
  'Bộ nhớ RAM': 'RAM Memory',
  'Tổng số trang in': 'Total Printed Pages',
  'Màn hình điều khiển': 'Control Panel LCD',
  'Thời gian chạy': 'Uptime',
  'nhân': 'cores',
  'Ổ đĩa (cao nhất)': 'Disk (highest)',
  'Tổng số SSID': 'Total SSIDs',
  'Client kết nối': 'Connected Clients',
  'Băng thông (Download / Upload)': 'Bandwidth (Download / Upload)',
  'Trạng thái máy in': 'Printer Status',
  'Nhiệt độ CPU': 'CPU Temperature',
  'Nhiệt độ CPU (VM)': 'CPU Temperature (VM)',
  'Đang chạy PIN': 'On Battery',
  'Điện lưới AC': 'AC Power',
  'Nguồn / UPS': 'Power / UPS',
  '✅ Bình thường': '✅ Healthy',
  '❌ Lỗi SMART': '❌ SMART Error',
  'Trạng thái đĩa cứng': 'Disk Status',
  '🛡️ Cảnh báo DoS': '🛡️ DoS Alert',
  'Lưu lượng bất thường': 'Abnormal traffic',
  'Thông tin': 'Information',
  'Địa chỉ': 'Address',
  'Vị trí': 'Location',
  'Mức cảnh báo': 'Alert Severity',
  '(theo loại)': '(by type)',
  'Kiểm tra': 'Checks',
  'Ghi chú': 'Notes',
  'Hệ điều hành': 'OS',
  'Phiên bản': 'Version',
  'Báo cáo cuối': 'Last Report',
  'Ổ đĩa': 'Disks',
  'Cấu hình sản phẩm & In ấn (Product & Print Settings)': 'Product & Print Settings',
  'Model sản phẩm': 'Product Model',
  'Số Serial': 'Serial Number',
  'Mã Firmware': 'Firmware Version',
  'In 2 mặt tự động': 'Auto Duplex',
  'Bộ nhớ RAM máy in': 'Printer Memory (RAM)',
  'Ngôn ngữ in hỗ trợ': 'Supported Print Languages',
  'Màn hình điều khiển LCD': 'Control Panel Display',
  'Trạng thái thiết bị': 'Device Status',
  'Tổng trang đã in (Impressions)': 'Total Page Count (Impressions)',
  '⚠️ Sự cố máy in phát hiện:': '⚠️ Printer Issues Detected:',
  'Vật tư tiêu hao (Mực in & Cụm trống Drum)': 'Consumables (Toner & Drum Unit)',
  'Tên vật tư': 'Supply Name',
  'Phân loại': 'Category',
  'Mức còn lại': 'Remaining',
  'Dung lượng': 'Capacity',
  'Hộp mực (Toner)': 'Toner Cartridge',
  'Cụm trống (Drum)': 'Imaging Drum',
  'Hộp mực thải': 'Waste Toner',
  'Cụm sấy (Fuser)': 'Fuser Unit',
  'Băng tải': 'Transfer Belt',
  'Vật tư khác': 'Other Supply',
  'Cấu hình khay nạp giấy & Giấy in (Paper Settings)': 'Paper Trays & Media Settings',
  'Khay nạp': 'Input Tray',
  'Loại giấy (Media)': 'Media Type',
  'Khổ giấy': 'Paper Size',
  'Tình trạng': 'Status',
  'Sức chứa': 'Capacity',
  'Mặc định': 'Default',
  'A4 / Mặc định': 'A4 / Default',
  'tờ': 'sheets',
  'Thông tin mạng không dây & SSID (Wireless Networks)': 'Wireless Networks & SSIDs',
  'Tổng số SSID phát sóng': 'Total Broadcasting SSIDs',
  'Tổng số Client đang kết nối': 'Total Connected Clients',
  'Phân bổ theo băng tần': 'Band Distribution',
  'Bảng theo dõi ARP': 'ARP Monitoring Table',
  'Không có dữ liệu ARP': 'No ARP data',
  'Chi tiết các SSID & Số lượng Client kết nối': 'SSID Details & Connected Clients',
  'Tên SSID': 'SSID Name',
  'BSSID (MAC phát sóng)': 'BSSID (Radio MAC)',
  'Băng tần (Band)': 'Band',
  'Kênh': 'Channel',
  'Tỷ lệ Client': 'Client Share',
  'Bảng theo dõi ARP & Thiết bị kết nối': 'ARP Table & Connected Devices',
  'Lưu ý:': 'Note:',
  'Bảng ARP thu thập qua SNMP trên thiết bị AP có tính chất cục bộ (Local ARP Cache) và bị giới hạn bởi giao thức. Danh sách này phản ánh các thiết bị có giao tiếp Layer 3 trong mạng (như Gateway hoặc thiết bị cùng phân vầng), do đó có thể không hiển thị đầy đủ hoặc chính xác tuyệt đối IP và Hostname của tất cả các Client đang kết nối WiFi.': 'The ARP table collected via SNMP on the AP reflects its local Layer 3 ARP cache and is limited by protocol design. It shows devices with recent L3 communication (such as gateways or peers on the same subnet) and may not list the IP/Hostname of every bridged WiFi client.',
  '🔍 Tìm kiếm theo IP, MAC, Domain name / Hostname, SSID...': '🔍 Search by IP, MAC, Domain / Hostname, SSID...',
  'Địa chỉ IP': 'IP Address',
  'Địa chỉ MAC': 'MAC Address',
  'Tên miền / Hostname': 'Domain / Hostname',
  'SSID kết nối': 'Connected SSID',
  'Thiết bị hiện chưa ghi nhận bản ghi ARP nào hoặc không có dữ liệu phản hồi từ SNMP.': 'No ARP entries recorded or no SNMP ARP data returned.',
  'Hiện token (bí mật)': 'Show token (secret)',
  'Tạo token mới': 'Regenerate Token',
  'Tạo token mới? Agent đang dùng token cũ sẽ bị từ chối.': 'Regenerate token? Any agent using the old token will be rejected.',
  'Hồ sơ đang dùng': 'Active Profile',
  'tự nhận diện': 'auto-detected',
  'chọn tay': 'manual',
  'chưa kiểm chứng': 'unverified',
  'Không có: ': 'Not available: ',
  'Không đọc được: ': 'Failed to read: ',
  'đã thử OID: ': 'tried OIDs: ',
  'Chỉ số': 'Metric',
  'Giá trị': 'Value',
  'Ghi chú / lý do': 'Notes / Reason',
  'Chưa có dữ liệu SNMP.': 'No SNMP data yet.',
  'Hồ sơ SNMP': 'SNMP Profile',
  'Tự nhận diện': 'Auto-detect',
  'Xuất dữ liệu SNMP': 'Export SNMP Walk',
  'Đang đọc thiết bị...': 'Reading device...',
  'Đã xuất file .walk': 'Exported .walk file',
  'Đã đổi hồ sơ SNMP, đang đọc lại...': 'SNMP profile updated, re-polling...',
  'Nhận diện sai? Chọn hồ sơ khác. Thiết bị chưa được hỗ trợ? Xuất dữ liệu SNMP và gửi file .walk cho nhà phát triển.': 'Wrong profile? Select another above. Unsupported device? Export SNMP Walk and send the .walk file to the developer.',
  'Lịch sử tiêu hao Vật tư (Mực in & Drum %)': 'Consumables History (Toner & Drum %)',
  'Mực in (%)': 'Toner (%)',
  'Độ bền Drum (%)': 'Drum Life (%)',
  'Lịch sử sử dụng Bộ nhớ máy in (RAM %)': 'Printer Memory Usage History (RAM %)',
  'RAM máy in (%)': 'Printer RAM (%)',
  'CPU / RAM / Ổ đĩa (%)': 'CPU / RAM / Disk (%)',
  'Độ trễ ping (ms)': 'Ping Latency (ms)',
  'Tổng băng thông sử dụng': 'Total Bandwidth Usage',
  'Nhiệt độ CPU (°C)': 'CPU Temperature (°C)',
  'Nhiệt độ (°C)': 'Temperature (°C)',
  'Lịch sử Mực in & Độ bền Drum (%)': 'Toner & Drum Life History (%)',
  'Chưa có dữ liệu lịch sử': 'No historical data available',

  // Events View
  'Nhật ký sự kiện': 'Event Log',
  'Tất cả': 'All',

  // KPI Modal
  'Thiết bị Mất kết nối': 'Disconnected Devices',
  'Tất cả thiết bị đang kết nối tốt!': 'All devices are connected!',
  'Hiện tại không có thiết bị nào bị ngắt kết nối mạng hoặc mất tín hiệu.': 'There are currently no disconnected or unreachable devices.',
  'Thiết bị đang Cảnh báo': 'Devices with Active Warnings',
  'Hệ thống an toàn, không có cảnh báo!': 'System is healthy, no active warnings!',
  'Tất cả thông số vận hành (CPU, RAM, Đĩa, Mực in, Drum, Cảm biến,...) đều ở mức an toàn.': 'All operating metrics (CPU, RAM, Disk, Toner, Drum, Sensors, etc.) are within normal thresholds.',
  'Thiết bị Chưa rõ / Bảo trì': 'Unknown / Maintenance Devices',
  'Không có thiết bị cần lưu ý!': 'No devices in unknown or maintenance state!',
  'Hiện không có thiết bị nào đang trong chế độ bảo trì hoặc chưa rõ dữ liệu.': 'No devices are currently in maintenance mode or awaiting initial data.',
  'Tất cả thiết bị đang Hoạt động': 'Active Devices',
  'Chưa có thiết bị nào hoạt động': 'No active devices found',
  'Hãy kiểm tra lại danh sách thiết bị hoặc thêm thiết bị mới vào hệ thống.': 'Please check your device list or add new devices to the platform.',
  '🔍 Lọc thiết bị theo tên, IP, loại...': '🔍 Filter devices by name, IP, type...',
  'Lý do:': 'Reason:',
  'Không phản hồi ICMP / Mất tín hiệu agent': 'No ICMP response / Agent signal lost',
  'Thiết bị đang đặt ở chế độ bảo trì (đã tạm ngắt cảnh báo âm thanh & thông báo).': 'Device is in maintenance mode (sound alarms & notifications are muted).',
  'Chưa nhận được dữ liệu giám sát hoặc thiết bị mới được thêm vào.': 'No monitoring data received yet or device was recently added.',
  'Đang phản hồi tốt': 'Responding normally',
  'Xem chi tiết →': 'Details →',

  // Topology Maps
  'Thiết bị Uplink / Cha': 'Uplink / Parent Device',
  '(Không có / Tự động nhận diện)': '(None / Auto-detect)',
  'Sơ đồ topology': 'Topology Maps',
  '+ Tạo sơ đồ': '+ Create Map',
  'Chưa có sơ đồ nào.': 'No topology maps yet.',
  'Tạo sơ đồ': 'Create Map',
  'Tên sơ đồ': 'Map Name',
  '✏️ Chỉnh sửa': '✏️ Edit',
  '+ Thiết bị…': '+ Device…',
  '+ Nhóm…': '+ Group…',
  '+ Nhãn': '+ Label',
  '🔗 Nối dây': '🔗 Link',
  'Đổi tên': 'Rename',
  'Xóa mục chọn': 'Delete Selected',
  '💾 Lưu': '💾 Save',
  'Xóa sơ đồ': 'Delete Map',
  'Nhãn mới': 'New Label',
  'Bấm lần lượt 2 thiết bị để nối dây': 'Click 2 nodes sequentially to connect them',
  'Chọn một nhãn để đổi tên': 'Select a label to rename',
  'Đổi tên nhãn': 'Rename Label',
  'Chưa chọn mục nào': 'No item selected',
  'Đã lưu sơ đồ': 'Topology map saved',
  'Bỏ các thay đổi chưa lưu?': 'Discard unsaved changes?',
  '(đã xóa)': '(deleted)',

  // Admin: Devices & Settings
  'Thêm thiết bị': 'Add Device',
  'Tên thiết bị *': 'Device Name *',
  'IP / hostname': 'IP / Hostname',
  'Mức cảnh báo khi mất kết nối': 'Alert Severity on Disconnect',
  'Kiểm tra ICMP ping': 'ICMP Ping Check',
  'Có cài Agent': 'Agent Installed',
  'Giám sát SNMP': 'SNMP Monitoring',
  'Tự nhận diện (khuyến nghị)': 'Auto-detect (recommended)',
  'Thuộc nhóm': 'Member of Groups',
  'Chưa có nhóm': 'No groups',
  'Chế độ bảo trì (tắt cảnh báo)': 'Maintenance mode (mute alerts)',
  'Tắt cảnh báo trên thẻ thiết bị (Ẩn huy hiệu local)': 'Mute local card badges (Hide local alert badges)',
  'Xóa thiết bị': 'Delete Device',
  'Đã lưu thiết bị': 'Device saved',
  'Tìm…': 'Search…',
  '+ Thêm máy mới': '+ Install Agent',
  '+ Thêm thiết bị': '+ Add Device',
  'Trạng thái': 'Status',
  'Tên': 'Name',
  'Chưa có thiết bị': 'No devices',
  'Cần tạo enroll key': 'Enroll Key Required',
  'Vào Cài đặt → Đăng ký agent tự động, tạo một khóa dài ít nhất 16 ký tự rồi lưu trước khi cài máy mới.': 'Go to Settings → Auto Agent Enrollment, generate a key of at least 16 characters and save it before installing agents.',
  'Đã hiểu': 'Got it',
  'Chạy trên đúng máy cần giám sát. Linux/macOS sẽ hỏi enroll key; Windows dùng khóa trong lệnh bên dưới.': 'Run on the target machine to monitor. The command includes your server URL and enroll key.',
  'Sao chép': 'Copy',
  'Sau khi cài, máy sẽ tự xuất hiện trong dashboard với loại Máy chủ hoặc Máy ảo tùy agent báo cáo.': 'Once installed, the machine will automatically appear on the dashboard as a Server or VM.',
  'Đã sao chép lệnh cài': 'Install command copied to clipboard',
  'Chung': 'General',
  'Tên hệ thống': 'Organization / System Name',
  'Giao diện mặc định': 'Default Theme',
  'Ngôn ngữ mặc định': 'Default Language',
  'Mức cảnh báo mặc định theo loại thiết bị': 'Default Alert Severity by Device Type',
  'Lưu mức cảnh báo': 'Save Severities',
  'Ngưỡng tài nguyên & phát hiện mất kết nối': 'Resource Thresholds & Outage Detection',
  'Báo động quá nhiệt CPU (°C)': 'CPU Overheating Alert (°C)',
  'Cảnh báo DoS / Flood (gói tin/giây)': 'DoS / Flood Alert (packets/sec)',
  'Lưu ngưỡng': 'Save Thresholds',
  'Đăng ký agent tự động': 'Auto Agent Enrollment',
  'Agent mới có thể tự tạo thiết bị khi gửi dữ liệu kèm khóa này (token = enroll key). Để trống để tắt. Tối thiểu 16 ký tự.': 'New agents can auto-register devices when reporting with this key (token = enroll key). Leave empty to disable. Min 16 characters.',
  '(đang tắt)': '(disabled)',
  'Tạo ngẫu nhiên': 'Generate Random',
  'Đã lưu mức cảnh báo': 'Alert severities saved',
  'Đã lưu ngưỡng': 'Thresholds saved',
  'Đã lưu enroll key': 'Enroll key saved',
  'Tính năng': 'Features',
  'Khởi động lúc': 'Started At',
  'Ổ đĩa chứa database': 'Database Disk Volume',
  'Sắp đầy – đang tự dọn lịch sử': 'Disk Low – auto-trimming history',
  'Người dùng': 'Users',
  '+ Thêm': '+ Add User',
  'Vai trò': 'Role',
  'Admin: toàn quyền · Operator: xác nhận cảnh báo, chỉnh sơ đồ · Viewer: chỉ xem.': 'Admin: full access · Operator: acknowledge alerts & edit maps · Viewer: read-only.',
  'Sửa / đặt lại mật khẩu': 'Edit / Reset Password',
  'Thêm người dùng': 'Add User',
  'Copy Logs Kỹ thuật': 'Copy Tech Logs',
  'Chẩn đoán AI': 'AI Diagnosis',
  'Sao chép Logs Kỹ thuật': 'Copy Technical Logs',
  'Gửi AI Phân tích ngay': 'Run AI Analysis Now',
  'Logs Kỹ thuật Chẩn đoán': 'Technical Diagnostic Logs',
};

M.t = (s) => {
  if (M.S.lang !== 'en') return s;
  return I18N_EN[s] !== undefined ? I18N_EN[s] : s;
};

// Dynamic translation for backend-generated status reasons, event messages, printer statuses
M.trData = (str) => {
  if (!str || M.S.lang !== 'en') return String(str ?? '');
  let s = String(str);
  if (I18N_EN[s]) return I18N_EN[s];
  s = s
    .replace(/Không ping được \(ICMP\)/g, 'ICMP Ping failed')
    .replace(/Agent mất kết nối/g, 'Agent disconnected')
    .replace(/SNMP không phản hồi/g, 'SNMP no response')
    .replace(/Agent không gửi dữ liệu \(còn ping được\)/g, 'Agent silent (ICMP still reachable)')
    .replace(/Ổ đĩa cao:/g, 'High Disk:')
    .replace(/CPU cao:/g, 'High CPU:')
    .replace(/RAM cao:/g, 'High RAM:')
    .replace(/\(ngưỡng (\d+)%\)/g, '(threshold $1%)')
    .replace(/Mực còn (\d+)%/g, 'Toner low: $1%')
    .replace(/Độ bền drum còn (\d+)% \(cần thay drum\)/g, 'Drum life critical: $1% (replace drum)')
    .replace(/Độ bền drum sắp hết: (\d+)%/g, 'Drum life low: $1%')
    .replace(/Nghi ngờ tấn công Flood\/DoS/g, 'Suspected Flood/DoS Attack')
    .replace(/gói\/s/g, 'pkt/s')
    .replace(/gói\/giây/g, 'pkt/s')
    .replace(/cổng/g, 'ports')
    .replace(/Đĩa cứng báo lỗi SMART \/ Bad Sector/g, 'Disk SMART / Bad Sector failure')
    .replace(/Cảnh báo đĩa cứng \(SMART lỗi\/Bad Sector\)/g, 'Disk Alert (SMART / Bad Sector)')
    .replace(/Trạng thái đĩa cứng SMART đã trở lại bình thường/g, 'Disk SMART status returned to normal')
    .replace(/Nhiệt độ CPU quá cao: (\d+)°C \(ngưỡng (\d+)°C\)/g, 'CPU Overheating: $1°C (threshold $2°C)')
    .replace(/Báo động nhiệt độ CPU quá cao: (\d+)°C \(Thermal Throttling\)/g, 'CPU Overheating Alert: $1°C (Thermal Throttling)')
    .replace(/Nhiệt độ CPU đã trở lại mức an toàn/g, 'CPU temperature returned to normal')
    .replace(/Mất điện lưới \(On Battery\)/g, 'AC Power Loss (On Battery)')
    .replace(/Cảnh báo khẩn cấp: Mất điện lưới, đang chạy pin UPS/g, 'Emergency: AC Power Loss, running on UPS battery')
    .replace(/Đã có điện lưới trở lại \(nguồn AC ổn định\)/g, 'AC Power restored (stable)')
    .replace(/\(pin còn (\d+)%\)/g, '(battery $1%)')
    .replace(/Sự cố máy in - /g, 'Printer issue - ')
    .replace(/Máy in đã hoạt động bình thường/g, 'Printer returned to normal')
    .replace(/Tốc độ gói tin đã trở lại bình thường/g, 'Packet rate returned to normal')
    .replace(/mất kết nối:/g, 'disconnected:')
    .replace(/\[(?:Suppressed - (?:Mất kết nối từ|Do sập nguồn từ)|Đã chặn thông báo lẻ - Do sập nguồn từ):\s*([^\]]+)\]/g, '[Suppressed - Upstream failure from: $1]')
    .replace(/hoạt động trở lại sau (\d+)s/g, 'recovered after $1s')
    .replace(/Thêm thiết bị/g, 'Added device')
    .replace(/Xóa thiết bị/g, 'Deleted device')
    .replace(/Xuất dữ liệu SNMP của/g, 'Exported SNMP walk of')
    .replace(/Sẵn sàng \(Ready\/Idle\)/g, 'Ready / Idle')
    .replace(/Đang in \(Printing\)/g, 'Printing')
    .replace(/Đang khởi động \(Warmup\)/g, 'Warming up')
    .replace(/Kẹt giấy \(Paper jam\)/g, 'Paper Jam')
    .replace(/Hết giấy \(Out of paper\)/g, 'Out of Paper')
    .replace(/Sắp hết giấy \(Low paper\)/g, 'Low Paper')
    .replace(/Hết mực \(No toner\)/g, 'Out of Toner')
    .replace(/Sắp hết mực \(Low toner\)/g, 'Low Toner')
    .replace(/Mở nắp máy \(Door open\)/g, 'Cover / Door Open')
    .replace(/Cần bảo trì \(Service requested\)/g, 'Service Requested')
    .replace(/Còn giấy/g, 'OK / Loaded')
    .replace(/Hết giấy/g, 'Empty')
    .replace(/Có \(In 2 mặt tự động\)/g, 'Yes (Auto Duplex)');
  return s;
};

let dualChannel = null;
try {
  dualChannel = new window.BroadcastChannel('monitoring_sync');
  dualChannel.onmessage = (e) => {
    if (!e.data) return;
    if (e.data.type === 'theme' && e.data.theme) M.applyTheme(e.data.theme, false);
    else if (e.data.type === 'dual' && typeof e.data.dual === 'boolean') M.toggleDual(e.data.dual, false);
    else if (e.data.type === 'lang' && e.data.lang) M.applyLang(e.data.lang, false);
  };
} catch {}
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
M.$ = $;
M.$$ = $$;

M.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esc = M.esc;

M.ICON = { server: '🖥️', vm: '☁️', router: '🌐', switch: '🔀', firewall: '🛡️', ap: '📶', printer: '🖨️', ups: '🔋', pc: '💻', other: '📦' };
const TYPE_NAME_VI = { server: 'Máy chủ', vm: 'Máy ảo (VM)', router: 'Router', switch: 'Switch', firewall: 'Firewall', ap: 'Access Point', printer: 'Máy in', ups: 'UPS', pc: 'Máy trạm', other: 'Khác' };
const TYPE_NAME_EN = { server: 'Server', vm: 'Virtual Machine (VM)', router: 'Router', switch: 'Switch', firewall: 'Firewall', ap: 'Access Point', printer: 'Printer', ups: 'UPS', pc: 'Workstation', other: 'Other' };
const SEV_NAME_VI = { critical: 'Nghiêm trọng', high: 'Cao', medium: 'Trung bình', low: 'Thấp', none: 'Không cảnh báo' };
const SEV_NAME_EN = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', none: 'No Alert' };
const STATE_NAME_VI = { up: 'Online', warning: 'Cảnh báo', down: 'Mất kết nối', unknown: 'Chưa rõ', maint: 'Bảo trì' };
const STATE_NAME_EN = { up: 'Online', warning: 'Warning', down: 'Offline', unknown: 'Unknown', maint: 'Maint.' };

Object.defineProperty(M, 'TYPE_NAME', { get: () => (M.S.lang === 'en' ? TYPE_NAME_EN : TYPE_NAME_VI) });
Object.defineProperty(M, 'SEV_NAME', { get: () => (M.S.lang === 'en' ? SEV_NAME_EN : SEV_NAME_VI) });
Object.defineProperty(M, 'STATE_NAME', { get: () => (M.S.lang === 'en' ? STATE_NAME_EN : STATE_NAME_VI) });

M.statusClass = (d) => {
  if (d.severity === 'none') {
    if (d.status === 'down') return 'down sev-none';
    if (d.status === 'warning') return 'up';
    return d.status === 'unknown' ? '' : d.status;
  }
  return (d.status === 'down' ? `down sev-${d.severity}${d.acked ? ' acked' : ''}` : d.status === 'unknown' ? '' : d.status);
};
M.fmtDur = (sec) => {
  if (sec == null) return '—';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (M.S.lang === 'en') {
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return m ? `${m}m ${sec % 60}s` : `${sec}s`;
  }
  if (d) return `${d} ngày ${h} giờ`;
  if (h) return `${h} giờ ${m} phút`;
  return m ? `${m} phút ${sec % 60} giây` : `${sec} giây`;
};
M.fmtBytes = (b) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
M.fmtRate = (b) => {
  if (b == null) return '—';
  if (!Number.isFinite(b) || b <= 0) return '0 B/s';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i > 0 && b < 10 ? 1 : 0)} ${u[i]}`;
};
M.fmtTime = (ts) => new Date(ts).toLocaleString(M.S.lang === 'en' ? 'en-US' : 'vi-VN');
M.pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);

M.summarize = (devs) => {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  const s = { total: 0, alive: 0, down: 0, warning: 0, unknown: 0, maintenance: 0, level: 'ok', unacked: 0 };
  let worst = 0;
  for (const d of devs) {
    if (d.status === 'maint') { s.maintenance++; continue; }
    s.total++;
    if (d.status === 'up' || d.status === 'warning') s.alive++;
    if (d.status === 'down') s.down++;
    if (d.status === 'warning' && d.severity !== 'none') s.warning++;
    if (d.status === 'unknown') s.unknown++;
    if (d.status === 'down' || d.status === 'warning') {
      if (d.severity === 'none') continue;
      worst = Math.max(worst, rank[d.status === 'down' ? d.severity : (d.severity === 'low' ? 'low' : 'medium')] || 0);
      if (!d.acked) s.unacked++;
    }
  }
  s.level = ['ok', 'low', 'medium', 'high', 'critical'][worst];
  return s;
};

M.api = async (method, url, body) => {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') opt.headers['X-Requested-With'] = 'monitor';
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && M.S.user) { M.S.user = null; M.showLogin(); }
    if (r.status === 403 && /đổi mật khẩu/.test((data && data.error) || '')) M.forcePasswordChange();
    const e = new Error((data && data.error) || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
};

M.toast = (msg) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = M.t(msg);
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4000);
};

M.applyTheme = (t, broadcast = true) => {
  if (!['dark', 'light', 'neon'].includes(t)) t = 'neon';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  const sel = $('#theme-sel');
  if (sel) sel.value = t;
  if (broadcast && dualChannel) {
    try { dualChannel.postMessage({ type: 'theme', theme: t }); } catch {}
  }
};

M.applyLang = (lang, broadcast = true) => {
  if (!['vi', 'en'].includes(lang)) lang = 'vi';
  M.S.lang = lang;
  document.documentElement.lang = lang;
  localStorage.setItem('lang', lang);
  const sel = $('#lang-sel');
  if (sel) sel.value = lang;
  if (broadcast && dualChannel) {
    try { dualChannel.postMessage({ type: 'lang', lang }); } catch {}
  }
  if (M.S.user && !M.S.user.must_change && M.S.settings) {
    M.renderShell();
    M.updateChrome();
    M.route();
  }
};

M.closeModal = () => {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
  document.body.classList.remove('has-modal');
  document.documentElement.classList.remove('has-modal');
};

const modalRootEl = $('#modal-root');
if (modalRootEl) {
  new MutationObserver(() => {
    const open = modalRootEl.children.length > 0;
    document.body.classList.toggle('has-modal', open);
    document.documentElement.classList.toggle('has-modal', open);
  }).observe(modalRootEl, { childList: true });
}

// Modal with a form. onSubmit(formEl) may throw an Error to show a message and keep the dialog open.
M.modal = (title, bodyHtml, onSubmit, opts = {}) => {
  const root = $('#modal-root');
  document.body.classList.add('has-modal');
  document.documentElement.classList.add('has-modal');
  root.innerHTML = `<div class="overlay"><form class="modal ${opts.wide ? 'modal-lg' : ''}" autocomplete="off"><h3>${esc(M.t(title))}</h3>${bodyHtml}
    <div class="err" id="m-err"></div><div class="actions">
    ${opts.noCancel ? '' : `<button type="button" class="btn" data-close>${esc(M.t('Hủy'))}</button>`}
    <button class="btn primary" type="submit">${esc(M.t(opts.submit || 'Lưu'))}</button></div></form></div>`;
  const form = $('form', root);
  const overlay = root.firstElementChild;
  const onKey = (e) => {
    if (e.key === 'Escape') {
      window.removeEventListener('keydown', onKey);
      close();
    }
  };
  window.addEventListener('keydown', onKey);
  const close = () => {
    window.removeEventListener('keydown', onKey);
    M.closeModal();
  };
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target.closest('a[href]')) close();
  });
  if (!opts.noCancel) overlay.addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) close(); });
  overlay.addEventListener('wheel', (e) => { if (e.target === e.currentTarget) e.preventDefault(); }, { passive: false });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (onSubmit) await onSubmit(form);
      close();
    } catch (err) {
      $('#m-err').textContent = M.trData(err.message);
    }
  });
  const first = $('input:not([type=checkbox]), select', form);
  if (first) first.focus();
  return { form, close };
};

M.confirm = (msg, onYes) => M.modal('Xác nhận', `<p>${esc(M.t(msg))}</p>`, onYes, { submit: 'Đồng ý' });

// ---------- sound & continuous alarm for Critical / High unacknowledged alerts ----------
let audioCtx;
let alarmLoopTimer = null;

M.beep = (urgent = false) => {
  if (!M.S.sound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const pattern = urgent ? [0, 0.22, 0.44, 0.66] : [0, 0.25, 0.5];
    pattern.forEach((t, idx) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square';
      o.frequency.value = urgent ? (idx % 2 === 0 ? 960 : 780) : 880;
      g.gain.value = 0.08;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + t); o.stop(audioCtx.currentTime + t + 0.15);
    });
  } catch { /* audio unavailable */ }
};

// Checks if any device with severity 'critical' or 'high' (or emergency hardware/DoS alert) is in problem state and unacknowledged
M.hasUnackedHighOrCritical = (snap = M.S.snap) => {
  if (!snap || !Array.isArray(snap.devices)) return false;
  return snap.devices.some((d) => {
    if (d.acked || d.maintenance || d.severity === 'none') return false;
    if (d.status !== 'down' && d.status !== 'warning') return false;
    const isHighOrCrit = d.severity === 'critical' || d.severity === 'high';
    const hasEmergency = d.alerts && (d.alerts.dos || d.alerts.smart || d.alerts.thermal || d.alerts.power);
    return isHighOrCrit || hasEmergency;
  });
};

M.syncAlarmLoop = () => {
  const shouldRing = M.S.sound && !!M.S.user && M.hasUnackedHighOrCritical(M.S.snap);
  const btnSound = $('#btn-sound');
  if (btnSound) btnSound.classList.toggle('ringing', shouldRing);
  if (shouldRing) {
    if (!alarmLoopTimer) {
      alarmLoopTimer = setInterval(() => {
        if (!M.S.sound || !M.S.user || !M.hasUnackedHighOrCritical(M.S.snap)) {
          M.syncAlarmLoop();
          return;
        }
        M.beep(true);
      }, 3500);
    }
  } else if (alarmLoopTimer) {
    clearInterval(alarmLoopTimer);
    alarmLoopTimer = null;
  }
};

// ---------- login / password ----------
M.showLogin = () => {
  M.es && M.es.close();
  M.syncAlarmLoop();
  document.body.dataset.level = 'ok';
  M.closeModal();
  $('#app').innerHTML = `<div class="login-wrap"><form class="panel login" id="login-form">
    <h1>◉ Monitoring</h1>
    <div class="field"><label>${esc(M.t('Tên đăng nhập'))}</label><input class="inp" name="username" autocomplete="username" required autofocus></div>
    <div class="field"><label>${esc(M.t('Mật khẩu'))}</label><input class="inp" type="password" name="password" autocomplete="current-password" required></div>
    <div class="err" id="login-err"></div>
    <button class="btn primary" style="width:100%">${esc(M.t('Đăng nhập'))}</button></form></div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await M.api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
      M.S.user = r.user;
      M.boot();
    } catch (err) { $('#login-err').textContent = M.trData(err.message); }
  });
};

M.forcePasswordChange = () => {
  if ($('#pw-form')) return;
  M.changePassword(true);
};

M.changePassword = (forced) => {
  const { form } = M.modal(forced ? 'Bạn cần đổi mật khẩu trước khi sử dụng' : 'Đổi mật khẩu', `
    <div class="field"><label>${esc(M.t('Mật khẩu hiện tại'))}</label><input class="inp" type="password" name="current" autocomplete="current-password" required></div>
    <div class="field"><label>${esc(M.t('Mật khẩu mới (tối thiểu 8 ký tự)'))}</label><input class="inp" type="password" name="password" autocomplete="new-password" minlength="8" required></div>
    <div class="field"><label>${esc(M.t('Nhập lại mật khẩu mới'))}</label><input class="inp" type="password" name="again" autocomplete="new-password" required></div>`,
  async (f) => {
    const v = Object.fromEntries(new FormData(f));
    if (v.password !== v.again) throw new Error(M.t('Mật khẩu nhập lại không khớp'));
    await M.api('POST', '/api/auth/password', { current: v.current, password: v.password });
    M.S.user.must_change = false;
    M.toast('Đã đổi mật khẩu');
    if (forced) M.boot();
  }, { noCancel: !!forced, submit: 'Đổi mật khẩu' });
  form.id = 'pw-form';
};

M.logout = async () => {
  try { await M.api('POST', '/api/auth/logout', {}); } catch { /* ignore */ }
  M.S.user = null;
  M.syncAlarmLoop();
  M.showLogin();
};

M.versionText = () => {
  const v = M.S.settings && M.S.settings.version;
  if (!v) return '';
  return M.S.lang === 'en'
    ? `v${v.version} · build ${v.build} · code ${v.code}`
    : `v${v.version} · build ${v.build} · mã ${v.code}`;
};

// ---------- shell ----------
const NAV = [['#/', 'Tổng quan'], ['#/groups', 'Nhóm'], ['#/maps', 'Sơ đồ'], ['#/events', 'Sự kiện'], ['#/devices', 'Thiết bị'], ['#/settings', 'Cài đặt', 'admin']];

M.renderShell = () => {
  const u = M.S.user;
  $('#app').innerHTML = `
  <header class="top">
    <div class="brand" id="brand">◉ ${esc(M.S.settings.org_name)}</div>
    <nav class="main">${NAV.filter((n) => !n[2] || n[2] === u.role).map((n) => `<a href="${n[0]}" data-nav="${n[0]}">${esc(M.t(n[1]))}</a>`).join('')}</nav>
    <span class="chip" id="chip">–/–</span>
    <div class="tools">
      <button class="icon-btn ${M.S.sound ? 'on' : ''}" id="btn-sound" title="${esc(M.t('Âm thanh cảnh báo'))}">🔔</button>
      <button class="icon-btn" id="btn-rotate" title="${esc(M.t('Tự động luân phiên màn hình (chế độ TV)'))}">🔁</button>
      <button class="icon-btn ${M.S.dual ? 'on' : ''}" id="btn-dual" title="${esc(M.t('Chế độ màn hình đôi (Phím D): Chia 2 màn hình hoặc mở cửa sổ phụ'))}">🖥️🖥️</button>
      <button class="icon-btn" id="btn-tv" title="${esc(M.t('Chế độ màn hình lớn (phím F)'))}">📺</button>
      <select class="sel hide-tv" id="lang-sel" title="${esc(M.t('Ngôn ngữ hiển thị'))}">
        <option value="vi">🇻🇳 VI</option><option value="en">🇬🇧 EN</option></select>
      <select class="sel hide-tv" id="theme-sel" title="${esc(M.t('Giao diện'))}">
        <option value="neon">Neon</option><option value="dark">${esc(M.t('Tối'))}</option><option value="light">${esc(M.t('Sáng'))}</option></select>
      <button class="icon-btn hide-tv" id="btn-user" title="${esc(M.t('Đổi mật khẩu'))}">👤 ${esc(u.username)}</button>
      <button class="icon-btn hide-tv" id="btn-logout" title="${esc(M.t('Đăng xuất'))}">⎋</button>
    </div>
  </header>
  <div id="banner"></div>
  <main id="view"></main>
  <footer class="ver muted" id="ver">${esc(M.versionText())}</footer>`;
  $('#theme-sel').value = document.documentElement.dataset.theme;
  $('#theme-sel').addEventListener('change', async (e) => {
    M.applyTheme(e.target.value);
    try { await M.api('PUT', '/api/auth/theme', { theme: e.target.value }); } catch { /* non-critical */ }
  });
  $('#lang-sel').value = M.S.lang;
  $('#lang-sel').addEventListener('change', async (e) => {
    const lang = e.target.value;
    M.applyLang(lang);
    try { await M.api('PUT', '/api/auth/lang', { lang }); } catch { /* non-critical */ }
  });
  $('#btn-sound').addEventListener('click', (e) => {
    M.S.sound = !M.S.sound;
    localStorage.setItem('sound', M.S.sound ? '1' : '0');
    e.currentTarget.classList.toggle('on', M.S.sound);
    if (M.S.sound) M.beep(M.hasUnackedHighOrCritical(M.S.snap));
    M.syncAlarmLoop();
  });
  $('#btn-dual').addEventListener('click', () => M.toggleDual());
  $('#btn-tv').addEventListener('click', () => M.toggleTv());
  $('#btn-rotate').addEventListener('click', (e) => {
    M.S.rotate = !M.S.rotate;
    e.currentTarget.classList.toggle('on', M.S.rotate);
    M.toast(M.S.rotate ? 'Bật tự động luân phiên (dừng ở Tổng quan khi có cảnh báo)' : 'Tắt luân phiên');
    if (M.S.rotate && !M.S.tv) M.toggleTv();
  });
  $('#btn-user').addEventListener('click', () => M.changePassword(false));
  $('#btn-logout').addEventListener('click', M.logout);
};

M.toggleDual = (force, broadcast = true) => {
  M.S.dual = force !== undefined ? force : !M.S.dual;
  document.body.classList.toggle('dual-screen', M.S.dual);
  $('#btn-dual') && $('#btn-dual').classList.toggle('on', M.S.dual);
  localStorage.setItem('dual_screen', M.S.dual ? '1' : '0');
  M.toast(M.S.dual ? 'Bật chế độ màn hình đôi (Phím D)' : 'Tắt chế độ màn hình đôi');
  if (broadcast && dualChannel) {
    try { dualChannel.postMessage({ type: 'dual', dual: M.S.dual }); } catch {}
  }
  if ((location.hash || '#/') === '#/') {
    M.route();
  }
};

M.toggleTv = (force) => {
  M.S.tv = force !== undefined ? force : !M.S.tv;
  document.body.classList.toggle('tv', M.S.tv);
  $('#btn-tv') && $('#btn-tv').classList.toggle('on', M.S.tv);
  if (M.S.tv && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!M.S.tv && document.fullscreenElement) document.exitFullscreen?.();
};
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && M.S.tv) { M.S.tv = false; document.body.classList.remove('tv'); $('#btn-tv') && $('#btn-tv').classList.remove('on'); }
});
document.addEventListener('keydown', (e) => {
  if (!M.S.user || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'f' || e.key === 'F') M.toggleTv();
  if (e.key === 'd' || e.key === 'D') M.toggleDual();
});

M.updateChrome = () => {
  const snap = M.S.snap;
  if (!snap) return;
  const s = snap.summary;
  document.body.dataset.level = s.level;
  const chip = $('#chip');
  if (chip) chip.textContent = `${s.alive}/${s.total} alive`;
  document.title = `${s.down ? `(${s.down} DOWN) ` : ''}${s.alive}/${s.total} – ${M.S.settings.org_name}`;
  const banner = $('#banner');
  if (!banner) return;
  const bad = snap.devices.filter((d) => (d.status === 'down' || d.status === 'warning') && d.severity !== 'none');
  if (!bad.length) { banner.innerHTML = ''; return; }
  const down = bad.filter((d) => d.status === 'down');
  const rank = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
  bad.sort((a, b) => (b.status === 'down') - (a.status === 'down') || rank[b.severity] - rank[a.severity]);
  const isEn = M.S.lang === 'en';
  const title = down.length
    ? (isEn ? `⚠ ${down.length} device(s) disconnected` : `⚠ ${down.length} thiết bị mất kết nối`)
    : (isEn ? `⚠ ${bad.length} device(s) warning` : `⚠ ${bad.length} thiết bị cảnh báo`);
  const extra = down.length && bad.length > down.length
    ? (isEn ? ` · ${bad.length - down.length} warning` : ` · ${bad.length - down.length} cảnh báo`)
    : '';
  banner.innerHTML = `<div class="banner ${s.unacked ? 'blink' : ''}"><span>${title}${extra}</span>
    <span class="names">${bad.slice(0, 12).map((d) => `<a href="#/device/${d.id}">${M.ICON[d.type] || ''} ${esc(d.name)}</a>`).join(' · ')}${bad.length > 12 ? ' …' : ''}</span>
    ${s.unacked && M.S.user.role !== 'viewer' ? `<button class="btn sm" id="ack-all">${esc(M.t('Đã biết'))}</button>` : ''}</div>`;
  const ack = $('#ack-all');
  if (ack) ack.onclick = async () => {
    await Promise.all(bad.filter((d) => !d.acked).map((d) => M.api('POST', `/api/devices/${d.id}/ack`, {}).catch(() => {})));
    for (const d of bad) d.acked = true;
    M.syncAlarmLoop();
  };
};

M.noServer = () => {
  const banner = $('#banner');
  if (banner && Date.now() - M.S.lastSnapAt > 10000) {
    banner.innerHTML = `<div class="banner blink"><span>${esc(M.t('⚠ Mất kết nối tới máy chủ giám sát – dữ liệu hiển thị có thể đã cũ'))}</span></div>`;
    document.body.dataset.level = 'critical';
  }
};

let prevDown = new Set();
let prevWarnUrgent = new Set();
M.onSnapshot = (snap) => {
  M.S.snap = snap;
  M.S.lastSnapAt = Date.now();
  const nowDown = new Set(snap.devices.filter((d) => d.status === 'down' && d.severity !== 'none').map((d) => d.id));
  const nowWarnUrgent = new Set(snap.devices.filter((d) => d.status === 'warning' && !d.acked && d.severity !== 'none' && (d.severity === 'critical' || d.severity === 'high' || (d.alerts && (d.alerts.dos || d.alerts.smart || d.alerts.thermal || d.alerts.power)))).map((d) => d.id));
  const freshDown = snap.devices.filter((d) => nowDown.has(d.id) && !prevDown.has(d.id));
  const freshWarn = snap.devices.filter((d) => nowWarnUrgent.has(d.id) && !prevWarnUrgent.has(d.id));
  if (prevDown.size || M.S.firstSnapDone) {
    if (freshDown.length) {
      const prefix = M.S.lang === 'en' ? 'Disconnected' : 'Mất kết nối';
      M.toast(`${prefix}: ${freshDown.map((d) => d.name).join(', ')}`);
      M.beep(M.hasUnackedHighOrCritical(snap));
    } else if (freshWarn.length) {
      const prefix = M.S.lang === 'en' ? 'Alert' : 'Cảnh báo';
      M.toast(`${prefix}: ${freshWarn.map((d) => d.name).join(', ')}`);
      M.beep(true);
    }
  }
  M.S.firstSnapDone = true;
  prevDown = nowDown;
  prevWarnUrgent = nowWarnUrgent;
  M.updateChrome();
  M.syncAlarmLoop();
  const v = M.current;
  if (v && v.update) v.update(snap);
};

M.connect = () => {
  M.es && M.es.close();
  const es = new EventSource('/api/stream');
  M.es = es;
  es.addEventListener('snapshot', (e) => M.onSnapshot(JSON.parse(e.data)));
  es.onerror = async () => {
    if (es.readyState === EventSource.CLOSED) {
      try { await M.api('GET', '/api/auth/me'); setTimeout(M.connect, 2000); } catch { /* login shown by api() */ }
    }
  };
};

// ---------- router ----------
const ROUTES = [
  [/^#\/?$/, 'dashboard'], [/^#\/secondary$/, 'secondary'], [/^#\/groups$/, 'groups'], [/^#\/group\/(\d+)$/, 'group'], [/^#\/device\/(\d+)$/, 'device'],
  [/^#\/maps$/, 'maps'], [/^#\/map\/(\d+)$/, 'map'], [/^#\/events(?:\/(ai|events))?$/, 'events'], [/^#\/devices$/, 'devices'], [/^#\/settings$/, 'settings'],
];

M.route = async () => {
  if (!M.S.user || M.S.user.must_change) return;
  const hash = location.hash || '#/';
  let name = 'dashboard', args = [];
  for (const [re, n] of ROUTES) { const m = re.exec(hash); if (m) { name = n; args = m.slice(1); break; } }
  const navFor = { dashboard: '#/', groups: '#/groups', group: '#/groups', maps: '#/maps', map: '#/maps', events: '#/events', devices: '#/devices', settings: '#/settings' }[name];
  document.querySelectorAll('nav.main a').forEach((a) => a.classList.toggle('active', a.dataset.nav === navFor));
  if (M.current && M.current.destroy) M.current.destroy();
  const view = M.views[name];
  M.current = view;
  const el = $('#view');
  el.innerHTML = '';
  try { await view.render(el, ...args); } catch (e) { el.innerHTML = `<div class="panel err">${esc(M.trData(e.message))}</div>`; }
  if (M.S.snap && view.update) view.update(M.S.snap);
};
window.addEventListener('hashchange', M.route);

M.loadGroups = async () => { M.S.groups = (await M.api('GET', '/api/groups')).groups; };
M.loadMaps = async () => { M.S.maps = (await M.api('GET', '/api/maps')).maps; };

setInterval(M.noServer, 3000);
setInterval(async () => {
  if (!M.S.rotate || !M.S.user || M.S.tv === false) return;
  if (M.S.snap && M.S.snap.summary.unacked > 0) { if ((location.hash || '#/') !== '#/') location.hash = '#/'; return; }
  const targets = ['#/', ...M.S.groups.map((g) => `#/group/${g.id}`), ...M.S.maps.map((m) => `#/map/${m.id}`)];
  const i = targets.indexOf(location.hash || '#/');
  location.hash = targets[(i + 1) % targets.length];
}, 20000);

M.boot = async () => {
  try {
    const me = await M.api('GET', '/api/auth/me');
    M.S.user = me.user;
  } catch { return M.showLogin(); }
  if (M.S.user.must_change) { $('#app').innerHTML = ''; return M.forcePasswordChange(); }
  M.S.settings = await M.api('GET', '/api/settings');
  M.applyTheme(M.S.user.theme || localStorage.getItem('theme') || M.S.settings.default_theme);
  const initLang = M.S.user.lang || localStorage.getItem('lang') || M.S.settings.default_lang || 'vi';
  M.S.lang = ['vi', 'en'].includes(initLang) ? initLang : 'vi';
  document.documentElement.lang = M.S.lang;
  localStorage.setItem('lang', M.S.lang);
  await Promise.all([M.loadGroups(), M.loadMaps()]);
  if (M.S.dual) document.body.classList.add('dual-screen');
  M.renderShell();
  M.applyTheme(document.documentElement.dataset.theme);
  M.connect();
  M.route();
};

M.applyTheme(localStorage.getItem('theme') || 'neon');
window.addEventListener('DOMContentLoaded', M.boot);
