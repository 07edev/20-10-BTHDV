# Lab 3 - Fee Service và ngân hàng giả lập

## Chạy

```powershell
npm install
node bank-service.js
node fee-service.js
```

Fee Service chạy ở `4001`, ngân hàng ở `4002`.

```powershell
Invoke-RestMethod http://localhost:4001/students/1/fees
Invoke-RestMethod -Method Post -Uri http://localhost:4001/students/1/payments `
  -ContentType 'application/json' -Body '{"amount":100000}'
Invoke-RestMethod http://localhost:4002/stats
```

## Mô phỏng sự cố

Các biến môi trường được đọc khi khởi động ngân hàng:

```powershell
$env:DELAY_MS="5000"; $env:FAIL_RATE="0"; $env:DROP_RATE="0"; node bank-service.js
```

Fee Service dùng `BANK_URL` và timeout 4 giây:

```powershell
$env:BANK_URL="http://localhost:4999"; node fee-service.js
```

- Không kết nối được: `503`, `FAILED`.
- Timeout hoặc mất kết nối sau khi ngân hàng có thể đã trừ tiền: `504`, `PENDING`.
- Ngân hàng trả lỗi rõ ràng: giữ nguyên mã lỗi (ví dụ `402`), `FAILED`.
- Thành công: `201`, `PAID`.

Fee Service sử dụng một `http.Agent` keep-alive, tối đa 20 socket. Mỗi payment có
`Idempotency-Key` chính là `paymentId`, còn ngân hàng lưu giao dịch theo cả key và
reference để không trừ tiền hai lần. Fee Service thử lại tối đa hai lần cho lỗi
500 tạm thời hoặc lỗi kết nối không rõ trạng thái; không thử lại lỗi 400/402 và
không thử lại timeout, vì timeout phải trả nhanh `504 PENDING`.

## Chạy toàn bộ bài đo

Lệnh sau tự khởi động service riêng cho từng tình huống, chạy các bài đo và
in kết quả JSON:

```powershell
npm run test:all
```

Bộ đo kiểm tra:

1. Ngân hàng tắt: `503` và GET công nợ vẫn hoạt động.
2. Ngân hàng trễ 5 giây: `504 PENDING`, dưới 4,5 giây.
3. 200 giao dịch, 10 yêu cầu đồng thời, keep-alive và kết nối sau 6 giây nhàn rỗi.
4. DROP_RATE, FAIL_RATE và giao dịch vượt hạn mức 25.000.000đ.

Kết quả `charges`, `duplicates`, số thanh toán `PAID`, số kết nối và thời gian
được in ra để chép vào phần báo cáo của buổi lab.
