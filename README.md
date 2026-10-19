# QuickCut — Trình chỉnh sửa video nhanh

Ứng dụng web tĩnh, không cần đăng nhập, không backend, không cần npm. Hỗ trợ video, ảnh, nhạc; timeline nối tiếp; cắt hai đầu bằng tay nắm; tách clip bằng S; xóa đoạn giữa; đổi thứ tự; tốc độ 0.25–4×; âm lượng; fade in/out; chỉnh sáng, tương phản, bão hòa, phơi sáng, nhiệt độ màu, blur; ảnh tĩnh và hiệu ứng chuyển động; xuất video bằng MediaRecorder.

## Triển khai Vercel

1. Giải nén thư mục.
2. Đưa `index.html`, `style.css`, `app.js`, `vercel.json` lên GitHub (ở thư mục gốc repository).
3. Trong Vercel, chọn Add New > Project > Import Git Repository.
4. Framework Preset: Other; Build Command: để trống; Output Directory: `.`.
5. Deploy. Không cần biến môi trường hoặc API key.

Có thể chạy thử bằng `python -m http.server 8080` rồi mở http://localhost:8080. Không mở file:// trực tiếp nếu trình duyệt hạn chế API.

## Giới hạn cần biết

- Đây là MVP thực thi trực tiếp trong trình duyệt. Xuất dựa trên Canvas.captureStream + MediaRecorder theo thời gian thực; không phải bộ dựng video chuyên nghiệp. Video dài cần thời gian xuất tương đương thời lượng phát, có thể gặp vấn đề đồng bộ tùy trình duyệt/thiết bị.
- Chỉ xuất MP4 khi `MediaRecorder.isTypeSupported()` hỗ trợ MIME MP4. Nếu không, xuất WebM đúng định dạng (không đổi đuôi giả). Nếu cần MP4 chắc chắn trên mọi trình duyệt, cần thay export engine bằng WebCodecs/Mediabunny hoặc FFmpeg.wasm và kiểm thử đầy đủ.
- Ứng dụng ưu tiên Chrome/Edge desktop. Hãy kiểm thử với các tệp video thực tế trước khi dùng cho công việc quan trọng.
- Không lưu dự án sau khi đóng tab; hãy xuất video trước khi thoát. Không có chức năng upload dữ liệu lên server.
- Bộ lọc và chuyển động ảnh được render qua Canvas. Fade video là fade từ/đến nền đen; không có transition chồng lớp giữa hai clip.
