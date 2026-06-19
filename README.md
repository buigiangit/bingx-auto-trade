# BingX AI VST Bot

Bot Node.js lấy dữ liệu BingX Swap V2, phân tích EMA/RSI/MACD/ATR/Volume/Funding/OI/Spread bằng AI, lọc rủi ro và chạy ở môi trường VST mô phỏng.

## Chạy

```bash
cp .env.example .env
npm install
npm run once
```

## Chế độ chạy

- `SIGNAL_ONLY`: chỉ in tín hiệu, không gửi order.
- `TEST_ORDER`: gọi endpoint test order của BingX, không khớp lệnh.
- `VST_ORDER`: chỉ chạy trên `BINGX_ENV=prod-vst`, gửi lệnh mô phỏng VST.

Code chặn cứng `prod-live` để tránh tự động bắn lệnh tiền thật.

## Log

Tín hiệu lưu tại:

```txt
logs/signals.jsonl
```
