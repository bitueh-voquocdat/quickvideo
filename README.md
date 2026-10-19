# QuickCut — Video Editor chạy trên Vercel

QuickCut là ứng dụng web hoạt động thực tế để cắt, ghép, chỉnh video và ảnh nhanh ngay trong trình duyệt. **Không cần tài khoản, API key, backend, npm hoặc cơ sở dữ liệu.** Tệp video, ảnh và âm thanh nhập vào không được gửi lên server.

## Triển khai lên Vercel

1. Giải nén `QuickCut-Production-Vercel.zip`.
2. Tạo một GitHub repository mới; đưa **bốn tệp ở thư mục gốc** lên repository: `index.html`, `styles.css`, `app.js`, `vercel.json` (và `README.md` nếu muốn).
3. Mở https://vercel.com/new → Import Git Repository.
4. Chọn **Framework Preset: Other**; Build Command để trống; Output Directory: `.` (hoặc để mặc định nếu Vercel nhận diện ứng dụng tĩnh); Root Directory mặc định.
5. Deploy. Không có biến môi trường hay server function.

Chạy trên máy:

```bash
python -m http.server 8080
```

Truy cập http://localhost:8080 (không mở bằng `file://` nếu trình duyệt chặn API media).

## Các tính năng đã triển khai

- Nhập nhiều video MP4/WebM trình duyệt phát được; ảnh JPG/PNG/WebP; nhạc MP3/WAV và các định dạng âm thanh mà trình duyệt đọc được.
- Cắt hai đầu bằng cách kéo hai tay nắm hoặc nhập số giây nguồn ở bảng bên phải.
- Đặt playhead ở đoạn cần bỏ → bấm **S** để chia tại đầu đoạn → chia tại cuối đoạn → chọn clip ở giữa → **Delete**. Các đoạn còn lại tự nối lại.
- Ghép các clip bằng cách nhập liên tiếp, kéo đổi vị trí trên timeline hoặc dùng mũi tên ←/→.
- Tăng/giảm tốc độ từng đoạn 0,25×–4×; nút nhanh 0,5× / 1× / 1,5× / 2×.
- Tắt/bật âm thanh gốc của từng clip, điều chỉnh 0–200%; thêm nhiều tệp nhạc vào timeline và thay đổi vị trí/cắt đầu cuối nhạc.
- Fade In/Out cho video và âm thanh, riêng từng clip.
- Chỉnh brightness, contrast, saturation, exposure, temperature, blur; chế độ fit/fill.
- Chèn ảnh thành một đoạn riêng với thời lượng điều chỉnh; hiệu ứng zoom in/out, pan left/right.
- Xem trước, phóng to timeline, Undo/Redo, nhân bản, xóa đoạn, tạo dự án mới.
- Xuất **MP4 khi MediaRecorder của trình duyệt hỗ trợ**, hoặc **WebM**. Đúng định dạng MIME; không đổi đuôi giả; không watermark.

## Lưu ý thực tế về định dạng và hiệu năng

- Bộ dựng dùng `Canvas.captureStream` + Web Audio API + MediaRecorder. Quy trình xuất chạy **theo thời gian thực**; video 1 phút có thể cần khoảng 1 phút để xuất (hoặc lâu hơn). Giữ tab ở phía trước và không để máy ngủ.
- Trình duyệt Chrome/Edge trong bài kiểm thử tạo MP4 với **H.264 + Opus**. Đây là MP4 hợp lệ, FFprobe/FFmpeg đọc được, nhưng một số phần mềm/thiết bị cần **MP4 H.264 + AAC** và có thể không phát tiếng. QuickCut có thông báo điều này ngay tại hộp thoại xuất. WebM là tùy chọn thay thế, không phải MP4 phổ dụng.
- Không cam kết MP4 AAC hay tương thích mọi thiết bị, vì codec MediaRecorder phụ thuộc trình duyệt. Nếu yêu cầu MP4/AAC chuẩn phổ thông, cần bổ sung engine mã hóa riêng (WebCodecs + muxer hoặc FFmpeg.wasm) và kiểm thử codec cụ thể.
- Thiết bị yếu/video dài hoặc nặng có thể bị giảm tốc độ khung hình, giật hoặc lệch A/V. Đề xuất video ngắn 480p/720p và trình duyệt Chromium mới trên máy tính. 1080p cần phần cứng khỏe hơn.
- Video gốc có thể là định dạng trình duyệt không đọc được; chuyển sang MP4 H.264 trước khi nhập.
- Khi thoát hoặc tạo dự án mới, timeline không được lưu lại; các tệp gốc không bao giờ bị sửa. Hãy xuất video trước khi thoát.
- Không phát sinh phí API/server cho xử lý media. Vercel Hobby có hạn mức và điều kiện sử dụng riêng.

## Phím tắt

| Phím | Thao tác |
|---|---|
| Space | Phát / dừng |
| S | Chia clip tại playhead |
| Delete / Backspace | Xóa clip đang chọn |
| Ctrl+Z | Hoàn tác |
| Ctrl+Y / Ctrl+Shift+Z | Làm lại |

## Kiểm tra đã chạy (19/10/2026)

Thử nghiệm tự động với Chromium 144 qua Playwright và các tệp được tạo bằng FFmpeg:

1. Nhập 2 video MP4 H.264/AAC + 1 ảnh PNG + 1 MP3.
2. Chỉnh trim, split, delete, undo, speed, mute, fade, brightness, chuyển động ảnh, phát/tạm dừng, tạo mới.
3. Xuất MP4 480p từ timeline nhiều clip, rồi kiểm tra bằng `ffprobe`: chứa track H.264 và Opus, thời lượng khoảng 8 giây, giải mã video và audio thành công; không có JavaScript page exception trong lần kiểm thử.

**Giới hạn kiểm thử:** Môi trường chạy Playwright đã nạp HTML/CSS/JS trực tiếp (hạn chế điều hướng nội bộ của trình kiểm thử), nên không thay thế được kiểm thử bổ sung sau khi deploy trên Vercel và trên thiết bị của bạn. Không thể bảo đảm mọi định dạng nguồn và mọi trình duyệt.

## Cấu trúc

```text
QuickCut/
├── index.html    # Giao diện chính
├── styles.css    # Giao diện và responsive
├── app.js        # Nhập file, timeline, preview, mixer, export
├── vercel.json   # Cấu hình hosting tĩnh
└── README.md
```

Tác giả của mã nguồn ứng dụng QuickCut trong gói này: OpenAI ChatGPT theo yêu cầu người dùng; mã nguồn không phụ thuộc thư viện CDN ngoài.
