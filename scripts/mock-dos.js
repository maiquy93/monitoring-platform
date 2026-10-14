#!/usr/bin/env node
'use strict';

/**
 * Script giả lập tấn công Flood / DoS (NTP UDP 123, DNS UDP 53)
 * Mục đích: Kiểm tra ngưỡng cảnh báo (alert threshold) và hiển thị trực quan trên Dashboard
 *
 * Cách sử dụng:
 *   node scripts/mock-dos.js                              # Giả lập cho 192.168.60.50 trong 60s
 *   node scripts/mock-dos.js --pps=75000 --bandwidth=120  # Đẩy 75k gói/s và 120 MB/s
 *   node scripts/mock-dos.js --duration=120               # Giữ trạng thái cảnh báo trong 120s
 *   node scripts/mock-dos.js --stop                       # Dừng giả lập ngay lập tức
 */

const http = require('node:http');

// Đọc tham số từ dòng lệnh
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  if (match) return match.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return def;
};
const hasFlag = (name) => args.includes(`--${name}`);

if (hasFlag('help') || hasFlag('h')) {
  console.log(`
Công cụ giả lập tấn công Flood/DoS kiểm tra cảnh báo Dashboard

Tùy chọn:
  --device=<ip|name|id>   Địa chỉ IP, tên hoặc ID thiết bị (mặc định: 192.168.60.50)
  --pps=<number>          Số lượng gói tin/giây (mặc định: 55000 pps, vượt ngưỡng 10.000)
  --bandwidth=<mb/s>      Băng thông mạng MB/s (mặc định: 85 MB/s)
  --ports=<p1,p2>         Cổng giao thức UDP (mặc định: 53,123)
  --duration=<sec>        Thời gian duy trì cảnh báo tính bằng giây (mặc định: 60s)
  --attack=<text>         Mô tả loại tấn công (mặc định: "DNS/NTP UDP Flood (cổng 53, 123)")
  --stop                  Hủy bỏ giả lập và phục hồi thiết bị về bình thường
  --port=<port>           Cổng backend monitoring (mặc định: 8080)
`);
  process.exit(0);
}

const targetDevice = getArg('device', '192.168.60.50');
const pps = Number(getArg('pps', 55000));
const bandwidth = Number(getArg('bandwidth', 85));
const ports = getArg('ports', '53,123').split(',').map((p) => Number(p.trim())).filter(Boolean);
const duration = Number(getArg('duration', 60));
const attackType = getArg('attack', `DNS/NTP UDP Flood (cổng ${ports.join(', ')})`);
const stopNow = hasFlag('stop');
const serverPort = Number(getArg('port', 8080));

const path = require('node:path');
const { open } = require('../server/db');

function getDeviceFromDb(target) {
  const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'monitor.db');
  const db = open(dbFile);
  try {
    const dev = db.prepare('SELECT id, name, address, type, agent_token FROM devices WHERE address = ? OR name = ? OR CAST(id AS TEXT) = ?').get(target, target, target);
    const all = db.prepare('SELECT id, name, address, type FROM devices').all();
    return { dev, all };
  } finally {
    db.close();
  }
}

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(json.error || `HTTP ${res.statusCode}: ${chunks}`));
        } catch {
          reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Không kết nối được tới server monitoring (port ${serverPort}): ${err.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('\n======================================================');
  console.log('🚀 CÔNG CỤ GIẢ LẬP DỮ LIỆU CẢNH BÁO FLOOD / DOS');
  console.log('======================================================\n');

  try {
    // 1. Lấy thông tin thiết bị trực tiếp từ DB
    const { dev, all } = getDeviceFromDb(targetDevice);

    if (!dev) {
      console.error(`❌ Không tìm thấy thiết bị có thông tin "${targetDevice}" trên hệ thống!`);
      console.log('Danh sách thiết bị hiện có:');
      all.forEach((d) => console.log(`  - [ID ${d.id}] ${d.name} (${d.address}) - Loại: ${d.type}`));
      process.exit(1);
    }

    console.log(`📌 Thiết bị mục tiêu: [ID ${dev.id}] ${dev.name} (${dev.address}) - ${dev.type.toUpperCase()}`);

    // Nếu người dùng yêu cầu dừng
    if (stopNow) {
      console.log('🛑 Đang gửi lệnh phục hồi và dừng giả lập DoS...');
      await request('POST', `/api/devices/${dev.id}/mock-dos`, { active: false }, dev.agent_token);
      console.log('✅ Đã khôi phục thiết bị về trạng thái bình thường!');
      process.exit(0);
    }

    console.log(`📊 Chỉ số giả lập đẩy vào backend:`);
    console.log(`   • Tốc độ gói tin (PPS): ${pps.toLocaleString('vi-VN')} gói/giây (Ngưỡng cảnh báo: 10.000 gói/s)`);
    console.log(`   • Băng thông mạng:      ${bandwidth} MB/s (${(bandwidth * 8).toFixed(1)} Mbps)`);
    console.log(`   • Cổng dịch vụ UDP:     ${ports.join(', ')} (NTP port 123, DNS port 53)`);
    console.log(`   • Loại tấn công:        ${attackType}`);
    console.log(`   • Thời gian duy trì:    ${duration} giây`);
    console.log('------------------------------------------------------');

    // 2. Kích hoạt giả lập
    const res = await request('POST', `/api/devices/${dev.id}/mock-dos`, {
      active: true,
      pps,
      bandwidth_mbps: bandwidth,
      ports,
      attack_type: attackType,
      duration_sec: duration,
    }, dev.agent_token);

    console.log('🔥 ĐÃ KÍCH HOẠT CẢNH BÁO VƯỢT NGƯỠNG THÀNH CÔNG VÀO BACKEND!\n');
    console.log('👀 HƯỚNG DẪN KIỂM TRA TRÊN DASHBOARD:');
    console.log('   1. Tại trang Dashboard Tổng quan:');
    console.log(`      - Thẻ "${dev.name}" hiển thị nhãn cảnh báo: 🛡️ DoS ${Math.round(pps / 1000)}k pps.`);
    console.log('      - Dòng trạng thái thẻ hiển thị nguyên nhân: "Nghi ngờ tấn công Flood/DoS...".');
    console.log('      - Thanh Header trên cùng chuyển sang màu Đỏ báo động khẩn cấp (Critical Level).');
    console.log('   2. Thẻ KPI "CẢNH BÁO" ở hàng đầu:');
    console.log('      - Số lượng cảnh báo tăng thêm 1.');
    console.log(`      - Bấm vào thẻ "Cảnh báo" -> Popup hiển thị chi tiết: "Tấn công Flood/DoS: ${attackType}".`);
    console.log('   3. Tại trang Chi tiết Thiết bị:');
    console.log(`      - Gauge hiển thị: "🛡️ Cảnh báo DoS" (${pps.toLocaleString('vi-VN')} gói/s).`);
    console.log(`      - Biểu đồ băng thông Download tăng vọt lên ~${bandwidth} MB/s.`);
    console.log('      - Bảng Nhật ký sự kiện ghi nhận sự kiện loại "dos" mức Critical.');
    console.log('------------------------------------------------------');

    // Thiết lập xử lý thoát sạch sẽ khi bấm Ctrl+C
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      console.log('\n\n🛑 Đang gửi tín hiệu kết thúc giả lập và phục hồi trạng thái bình thường...');
      try {
        await request('POST', `/api/devices/${dev.id}/mock-dos`, { active: false }, dev.agent_token);
        console.log('✅ Hệ thống đã ghi nhận phục hồi an toàn (Event: Tốc độ gói tin đã trở lại bình thường).');
      } catch (e) {
        console.error('Lỗi khi gửi lệnh dừng:', e.message);
      }
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Đồng hồ đếm ngược
    let remaining = duration;
    const interval = setInterval(async () => {
      remaining--;
      process.stdout.write(`\r⏱️  Đang duy trì cảnh báo DoS... Còn lại: ${remaining}s (Bấm Ctrl+C để dừng sớm)   `);

      // Gửi tín hiệu duy trì mỗi 15s nếu thời gian dài
      if (remaining > 0 && remaining % 15 === 0) {
        try {
          await request('POST', `/api/devices/${dev.id}/mock-dos`, {
            active: true,
            pps,
            bandwidth_mbps: bandwidth,
            ports,
            attack_type: attackType,
            duration_sec: remaining + 5,
          }, dev.agent_token);
        } catch {}
      }

      if (remaining <= 0) {
        clearInterval(interval);
        console.log('\n\n⌛ Hết thời gian giả lập!');
        await cleanup();
      }
    }, 1000);

  } catch (err) {
    console.error('❌ Lỗi:', err.message);
    process.exit(1);
  }
}

main();
