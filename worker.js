const SECRET_KEY = "asdfhkhktvdxcvwer";
const TELEGRAM_BOT_TOKEN = "xxxxxxxxxxxxxxxxxxxxxxxx";
const CHAT_ID = ["5xxxxxx63"];
const BUCKET_NAME = "images";
const BASE_URL = "https://xx.xx.xx";
export default {
	async fetch(request, env) {
		const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

		const url = new URL(request.url);
		const path = url.pathname;

		try {
			if (path === '/webhook' && request.method === 'POST') {
				return handleTelegramWebhook(request, env, TELEGRAM_API_URL, CHAT_ID, BUCKET_NAME, BASE_URL);
			}
			// Web interface routes
			if (path === '/login' && request.method === 'POST') {
				return handleLogin(request, SECRET_KEY);
			}
			if (path === '/' || path === '/index.html') {
				return serveLoginPage();
			}
			if (path === '/upload' && await isAuthenticated(request, SECRET_KEY)) {
				return serveUploadPage();
			}
			if (path === '/gallery' && await isAuthenticated(request, SECRET_KEY)) {
				return serveGalleryPage();
			}
			if (path === '/api/upload' && request.method === 'POST' && await isAuthenticated(request, SECRET_KEY)) {
				return handleWebUpload(request, env[BUCKET_NAME], BASE_URL);
			}
			if (path === '/api/list' && await isAuthenticated(request, SECRET_KEY)) {
				return handleListFiles(request, env[BUCKET_NAME]);
			}
			if (path === '/api/delete' && request.method === 'POST' && await isAuthenticated(request, SECRET_KEY)) {
				return handleDeleteFiles(request, env[BUCKET_NAME]);
			}
			if (path === '/api/create-folder' && request.method === 'POST' && await isAuthenticated(request, SECRET_KEY)) {
				return handleCreateFolder(request, env[BUCKET_NAME]);
			}

			// Telegram bot routes
			if (path === '/setWebhook') {
				const webhookUrl = `${url.protocol}//${url.host}/webhook`;
				const webhookResponse = await setWebhook(webhookUrl, TELEGRAM_API_URL);
				if (webhookResponse.ok) {
					return new Response(`Webhook set successfully to ${webhookUrl}`);
				}
				return new Response('Failed to set webhook', {status: 500});
			}

			return new Response('Not found', {status: 404});
		} catch (err) {
			console.error(err);
			return new Response('Server error', {status: 500});
		}
	}
};

async function setWebhook(webhookUrl, apiUrl) {
	try {
		const response = await fetch(`${apiUrl}/setWebhook`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({url: webhookUrl}),
		});

		const result = await response.json();

		if (!result.ok) {
			console.error('Failed to set webhook:', result.description);
		}

		return result;
	} catch (error) {
		console.error('Error setting webhook:', error);
		return {ok: false, description: error.message};
	}
}

function detectImageType(uint8Array) {
	// Check for JPEG signature (FF D8 FF)
	if (uint8Array.length >= 3 &&
		uint8Array[0] === 0xFF &&
		uint8Array[1] === 0xD8 &&
		uint8Array[2] === 0xFF) {
		return {mime: 'image/jpeg', ext: 'jpg'};
	}

	// Check for PNG signature (89 50 4E 47 0D 0A 1A 0A)
	const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	if (uint8Array.length >= pngSignature.length) {
		const isPng = pngSignature.every(
			(byte, index) => uint8Array[index] === byte
		);
		if (isPng) return {mime: 'image/png', ext: 'png'};
	}

	// Add more image type detection as needed (GIF, WebP, etc.)

	return null;
}

async function handleTelegramWebhook(request, env, TELEGRAM_API_URL, CHAT_ID, BUCKET_NAME, BASE_URL) {
	try {
		const update = await request.json();

		if (!update.message) {
			return new Response('OK');
		}

		const chatId = update.message.chat.id;

		// Check if user is authorized
		if (!CHAT_ID.includes(chatId.toString())) {
			return new Response('Unauthorized access', {status: 403});
		}

		// Get functions for path management
		async function getUserPath(chatId) {
			const path = await env.INDEXES_KV.get(chatId.toString());
			if (path === '/') {
				return '';
			}
			return path || ''; // Default to empty string (root path)
		}

		async function setUserPath(chatId, path) {
			await env.INDEXES_KV.put(chatId.toString(), path);
		}

		// Handle media uploads
		async function handleMediaUpload(chatId, fileId, isDocument = false) {
			try {
				await sendMessage(chatId, '收到文件，正在上传ing', TELEGRAM_API_URL);

				const fileUrl = await getFileUrl(fileId, TELEGRAM_BOT_TOKEN);
				const userPath = await getUserPath(chatId);
				const uploadResult = await uploadImageToR2(fileUrl, env[BUCKET_NAME], isDocument, userPath);

				if (uploadResult.ok) {
					const imageUrl = `${BASE_URL}/${uploadResult.key}`;
					const caption = `✅ 图片上传成功！\n直链\n<code>${imageUrl}</code>\nMarkdown\n<code>![img](${imageUrl})</code>`;
					await sendPhoto(chatId, imageUrl, TELEGRAM_API_URL, caption, {parse_mode: "HTML"});
				} else {
					await sendMessage(chatId, uploadResult.message, TELEGRAM_API_URL);
				}
			} catch (error) {
				console.error('处理文件失败:', error);
				await sendMessage(chatId, '文件处理失败，请稍后再试。', TELEGRAM_API_URL);
			}
		}

		// Process text messages
		if (update.message.text) {
			const text = update.message.text.trim();

			// Handle /modify command
			if (text.startsWith('/modify')) {
				const parts = text.split(' ');
				if (parts.length >= 2) {
					const newPath = parts[1].trim();
					await setUserPath(chatId, newPath);
					await sendMessage(chatId, `修改路径为${newPath}`, TELEGRAM_API_URL);
				} else {
					await sendMessage(chatId, '请指定路径，例如：/modify blog', TELEGRAM_API_URL);
				}
				return new Response('OK');
			}

			// Handle /status command
			if (text === '/status') {
				const currentPath = await getUserPath(chatId);
				const statusMessage = currentPath ? `当前路径: ${currentPath}` : '当前路径: / (默认)';
				await sendMessage(chatId, statusMessage, TELEGRAM_API_URL);
				return new Response('OK');
			}

			// Default message for any other text
			let mes = `请发送一张图片！\n或者使用以下命令：\n/modify 修改上传图片的存储路径\n/status 查看当前上传图片的路径`;
			await sendMessage(chatId, mes, TELEGRAM_API_URL);
			return new Response('OK');
		}

		// Handle document files
		if (update.message.document) {
			const doc = update.message.document;
			const fileName = doc.file_name || '';
			const fileExt = fileName.split('.').pop().toLowerCase();

			if (!['jpg', 'jpeg', 'png'].includes(fileExt)) {
				await sendMessage(chatId, '不支持的文件类型，请发送 JPG/PNG 格式文件', TELEGRAM_API_URL);
				return new Response('OK');
			}

			await handleMediaUpload(chatId, doc.file_id, true);
			return new Response('OK');
		}

		// Handle photos
		if (update.message.photo) {
			const fileId = update.message.photo.slice(-1)[0].file_id;
			await handleMediaUpload(chatId, fileId);
			return new Response('OK');
		}

		return new Response('OK');
	} catch (err) {
		console.error(err);
		return new Response('Error processing request', {status: 500});
	}
}

// Authentication Functions
async function isAuthenticated(request, secretKey) {
	const cookies = parseCookies(request.headers.get('Cookie') || '');
	return cookies.auth === hashKey(secretKey).replace(/=/g, '');
}

async function handleLogin(request, secretKey) {
	const formData = await request.formData();
	const inputKey = formData.get('key');

	if (inputKey === secretKey) {
		const headers = new Headers();
		headers.append('Set-Cookie', `auth=${hashKey(secretKey).replace(/=/g, '')}; HttpOnly; Path=/; Max-Age=86400`);
		headers.append('Location', '/upload');
		return new Response(null, {
			status: 302,
			headers
		});
	}

	return serveLoginPage("密钥错误，请重新输入");
}

function hashKey(key) {
	// Simple hash function for demo purposes
	// In production, use a proper crypto hash
	return btoa(key);
}

function parseCookies(cookieString) {
	const cookies = {};
	cookieString.split(';').forEach(cookie => {
		const [name, value] = cookie.trim().split('=');
		if (name) cookies[name] = value;
	});
	return cookies;
}

// Page Rendering Functions
function serveLoginPage(errorMessage = null) {
	const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>R2管理 - 登录</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        body {
          background-color: #fbfbfd;
          color: #1d1d1f;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
        }

        .login-container {
          background-color: white;
          border-radius: 18px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1);
          width: 90%;
          max-width: 420px;
          padding: 2.5rem;
          text-align: center;
        }

        h1 {
          font-weight: 600;
          font-size: 1.8rem;
          margin-bottom: 1.5rem;
        }

        .input-group {
          margin-bottom: 2rem;
        }

        input {
          width: 100%;
          padding: 0.8rem 1rem;
          border: 1px solid #d2d2d7;
          border-radius: 12px;
          font-size: 1rem;
          transition: border-color 0.3s;
        }

        input:focus {
          outline: none;
          border-color: #0071e3;
          box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.2);
        }

        button {
          background-color: #0071e3;
          color: white;
          border: none;
          border-radius: 12px;
          padding: 0.8rem 2rem;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.3s;
        }

        button:hover {
          background-color: #0062c1;
        }

        .error-message {
          color: #ff3b30;
          margin-top: 1rem;
          font-size: 0.9rem;
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <h1>R2管理</h1>
        <form action="/login" method="post">
          <div class="input-group">
            <input type="password" name="key" placeholder="请输入访问密钥" required>
          </div>
          <button type="submit">登录</button>
          ${errorMessage ? `<p class="error-message">${errorMessage}</p>` : ''}
        </form>
      </div>
    </body>
    </html>
    `;

	return new Response(html, {
		headers: {'Content-Type': 'text/html; charset=utf-8'}
	});
}

function serveUploadPage() {
	const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>R2管理 - 上传</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        body {
          background-color: #fbfbfd;
          color: #1d1d1f;
          min-height: 100vh;
        }

        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem 2rem;
          background-color: rgba(255, 255, 255, 0.8);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-bottom: 1px solid #d2d2d7;
          position: sticky;
          top: 0;
          z-index: 100;
        }

        .logo {
          font-weight: 600;
          font-size: 1.5rem;
        }

        .nav-links a {
          color: #0071e3;
          font-weight: 500;
          text-decoration: none;
          margin-left: 1.5rem;
          transition: opacity 0.3s;
        }

        .nav-links a:hover {
          opacity: 0.7;
        }

        main {
          max-width: 900px;
          margin: 3rem auto;
          padding: 0 1.5rem;
        }

        .upload-container {
          background-color: white;
          border-radius: 18px;
          box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
          padding: 2.5rem;
          margin-bottom: 2rem;
        }

        h1 {
          font-weight: 600;
          font-size: 1.8rem;
          margin-bottom: 1.5rem;
        }

        .dropzone {
          border: 2px dashed #d2d2d7;
          border-radius: 12px;
          padding: 3rem 1.5rem;
          text-align: center;
          cursor: pointer;
          transition: all 0.3s;
          margin-bottom: 1.5rem;
        }

        .dropzone:hover, .dropzone.active {
          border-color: #0071e3;
          background-color: rgba(0, 113, 227, 0.05);
        }

        .dropzone-icon {
          font-size: 3rem;
          color: #0071e3;
          margin-bottom: 1rem;
        }

        .path-input {
          margin-bottom: 1.5rem;
        }

        .path-input label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: 500;
        }

        input {
          width: 100%;
          padding: 0.8rem 1rem;
          border: 1px solid #d2d2d7;
          border-radius: 12px;
          font-size: 1rem;
          transition: border-color 0.3s;
        }

        input:focus {
          outline: none;
          border-color: #0071e3;
          box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.2);
        }

        button {
          background-color: #0071e3;
          color: white;
          border: none;
          border-radius: 12px;
          padding: 0.8rem 2rem;
          font-size: 1rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.3s;
          display: block;
          width: 100%;
        }

        button:hover {
          background-color: #0062c1;
        }

        .selected-files {
          margin-top: 1.5rem;
        }

        .preview-item {
          display: flex;
          align-items: center;
          background-color: #f5f5f7;
          border-radius: 8px;
          padding: 0.5rem 1rem;
          margin-bottom: 0.5rem;
        }

        .preview-item .file-name {
          flex-grow: 1;
          margin-left: 0.5rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .preview-item .remove-file {
          color: #ff3b30;
          background: none;
          border: none;
          cursor: pointer;
          font-size: 1rem;
          padding: 0.25rem;
          width: auto;
        }

        /* Success Modal Styles */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.5);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 1000;
          opacity: 0;
          visibility: hidden;
          transition: all 0.3s;
        }

        .modal-overlay.active {
          opacity: 1;
          visibility: visible;
        }

        .modal-content {
          background-color: white;
          border-radius: 18px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15);
          width: 90%;
          max-width: 500px;
          padding: 2rem;
          transform: translateY(-20px);
          transition: transform 0.3s;
        }

        .modal-overlay.active .modal-content {
          transform: translateY(0);
        }

        .modal-content {
		  max-height: 80vh;
		  overflow-y: auto;
		}

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1.5rem;
        }

        .modal-title {
          font-weight: 600;
          font-size: 1.5rem;
        }

        .modal-close {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          padding: 0.25rem;
          width: auto;
        }

        .link-item {
          background-color: #f5f5f7;
          border-radius: 8px;
          padding: 1rem;
          margin-bottom: 1rem;
        }

        .link-item h3 {
          font-size: 1rem;
          margin-bottom: 0.5rem;
        }

        .link-value {
          display: flex;
          align-items: center;
          background-color: white;
          border-radius: 6px;
          border: 1px solid #d2d2d7;
          padding: 0.5rem;
        }

        .link-text {
          flex-grow: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-family: monospace;
          font-size: 0.9rem;
          max-width: 20rem;
        }

        .copy-btn {
          background-color: #0071e3;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 0.25rem 0.75rem;
          font-size: 0.8rem;
          margin-left: 0.5rem;
          cursor: pointer;
          width: auto;
        }
      </style>
    </head>
    <body>
      <header>
        <div class="logo">R2管理</div>
        <div class="nav-links">
          <a href="/upload" class="active">上传图片</a>
          <a href="/gallery">图片管理</a>
        </div>
      </header>

      <main>
        <div class="upload-container">
          <h1>上传图片</h1>
          <div class="dropzone" id="dropzone">
            <div class="dropzone-icon">📤</div>
            <p>拖拽文件到此处或点击选择文件</p>
            <p class="sub-text">支持 JPG 和 PNG 格式</p>
            <input type="file" id="fileInput" style="display: none;" accept="image/jpeg,image/png" multiple>
          </div>

          <div class="path-input">
            <label for="customPath">自定义路径（可选）</label>
            <input type="text" id="customPath" placeholder="例如: blog/images">
          </div>

          <div class="selected-files" id="selectedFiles"></div>

          <button id="uploadBtn" disabled>上传图片</button>
        </div>
      </main>

      <div class="modal-overlay" id="successModal">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title">上传成功</h2>
            <button class="modal-close" id="closeModal">×</button>
          </div>
          <div class="modal-body" id="modalContent">
            <!-- Links will be populated here -->
          </div>
        </div>
      </div>

      <script>
        document.addEventListener('DOMContentLoaded', () => {
          const dropzone = document.getElementById('dropzone');
          const fileInput = document.getElementById('fileInput');
          const selectedFilesContainer = document.getElementById('selectedFiles');
          const uploadBtn = document.getElementById('uploadBtn');
          const customPath = document.getElementById('customPath');
          const successModal = document.getElementById('successModal');
          const closeModal = document.getElementById('closeModal');
          const modalContent = document.getElementById('modalContent');

          let selectedFiles = [];

          // Dropzone event listeners
          dropzone.addEventListener('click', () => fileInput.click());

          dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('active');
          });

          dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('active');
          });

          dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('active');
            handleFiles(e.dataTransfer.files);
          });

          fileInput.addEventListener('change', () => {
            handleFiles(fileInput.files);
          });

          function handleFiles(files) {
            const validFiles = Array.from(files).filter(file => {
              const fileType = file.type.toLowerCase();
              return fileType === 'image/jpeg' || fileType === 'image/png';
            });

            if (validFiles.length === 0) {
              alert('只支持 JPG 和 PNG 格式的图片文件');
              return;
            }

            selectedFiles = [...selectedFiles, ...validFiles];
            updateFilePreview();
            uploadBtn.disabled = selectedFiles.length === 0;
          }

          function updateFilePreview() {
            selectedFilesContainer.innerHTML = '';

            selectedFiles.forEach((file, index) => {
              const item = document.createElement('div');
              item.className = 'preview-item';

              item.innerHTML = \`
                <div class="file-icon">📄</div>
                <div class="file-name">\${file.name}</div>
                <button class="remove-file" data-index="\${index}">×</button>
              \`;

              selectedFilesContainer.appendChild(item);
            });

            // Add event listeners to remove buttons
            document.querySelectorAll('.remove-file').forEach(btn => {
              btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                selectedFiles.splice(index, 1);
                updateFilePreview();
                uploadBtn.disabled = selectedFiles.length === 0;
              });
            });
          }

          uploadBtn.addEventListener('click', async () => {
            if (selectedFiles.length === 0) return;

            uploadBtn.disabled = true;
            uploadBtn.textContent = '上传中...';

            const uploadPromises = selectedFiles.map(async (file) => {
              const formData = new FormData();
              formData.append('file', file);
              formData.append('path', customPath.value || '');

              try {
                const response = await fetch('/api/upload', {
                  method: 'POST',
                  body: formData
                });

                if (!response.ok) {
                  throw new Error('上传失败');
                }

                return await response.json();
              } catch (error) {
                console.error('Upload failed:', error);
                return { error: true, message: error.message };
              }
            });

            try {
              const results = await Promise.all(uploadPromises);
              displayResults(results);
            } catch (error) {
              alert('上传过程中发生错误，请重试');
            } finally {
              uploadBtn.disabled = false;
              uploadBtn.textContent = '上传图片';
              selectedFiles = [];
              updateFilePreview();
            }
          });

          function displayResults(results) {
            modalContent.innerHTML = '';

            const successfulUploads = results.filter(result => !result.error);

            if (successfulUploads.length === 0) {
              modalContent.innerHTML = '<p>所有上传都失败了，请重试。</p>';
            } else {
              successfulUploads.forEach(result => {
                const linkItem = document.createElement('div');
                linkItem.className = 'link-item';

                linkItem.innerHTML = \`
                  <h3>\${result.key}</h3>
                  <div class="link-section">
                    <h4>直接链接</h4>
                    <div class="link-value">
                      <span class="link-text">\${result.url}</span>
                      <button class="copy-btn" data-text="\${result.url}">复制</button>
                    </div>
                  </div>
                  <div class="link-section">
                    <h4>Markdown</h4>
                    <div class="link-value">
                      <span class="link-text">![img](\${result.url})</span>
                      <button class="copy-btn" data-text="![img](\${result.url})">复制</button>
                    </div>
                  </div>
                \`;

                modalContent.appendChild(linkItem);
              });
            }

            // Show modal
            successModal.classList.add('active');

            // Add copy functionality
            document.querySelectorAll('.copy-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                const textToCopy = btn.dataset.text;
                navigator.clipboard.writeText(textToCopy)
                  .then(() => {
                    const originalText = btn.textContent;
                    btn.textContent = '已复制';
                    setTimeout(() => {
                      btn.textContent = originalText;
                    }, 1500);
                  });
              });
            });
          }

          closeModal.addEventListener('click', () => {
            successModal.classList.remove('active');
          });

          // Close modal when clicking outside
          successModal.addEventListener('click', (e) => {
            if (e.target === successModal) {
              successModal.classList.remove('active');
            }
          });
        });
      </script>
    </body>
    </html>
    `;

	return new Response(html, {
		headers: {'Content-Type': 'text/html; charset=utf-8'}
	});
}

function serveGalleryPage() {
	const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>R2管理</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
        }
        body {
            background-color: #f5f7fa;
            color: #333;
            padding: 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 1px solid #e1e4e8;
        }
        .header h1 {
            font-size: 24px;
            color: #2c3e50;
        }
        .header-buttons {
            display: flex;
            gap: 10px;
        }
        .btn {
            background-color: #4b6bfb;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            transition: background-color 0.2s;
            text-decoration: none;
        }
        .btn:hover {
            background-color: #3a54d6;
        }
        .btn-danger {
            background-color: #e74c3c;
        }
        .btn-danger:hover {
            background-color: #c0392b;
        }
        .btn-secondary {
            background-color: #7f8c8d;
        }
        .btn-secondary:hover {
            background-color: #636e72;
        }
        .breadcrumb {
            margin-bottom: 20px;
            padding: 10px;
            background-color: white;
            border-radius: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .breadcrumb a {
            color: #4b6bfb;
            text-decoration: none;
        }
        .breadcrumb a:hover {
            text-decoration: underline;
        }
        .breadcrumb .separator {
            margin: 0 8px;
            color: #95a5a6;
        }
        .gallery-controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .select-all-container {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .select-all-checkbox {
            width: 18px;
            height: 18px;
            cursor: pointer;
        }
        .gallery {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 20px;
        }
        .item {
            background-color: white;
            border-radius: 6px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            transition: transform 0.2s;
            position: relative;
        }
        .item:hover {
            transform: translateY(-5px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        .directory {
            padding: 25px 15px;
            text-align: center;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
        }
        .directory-icon {
            font-size: 40px;
            color: #f39c12;
        }
        .file {
            cursor: pointer;
            position: relative;
        }
        .file-image {
            width: 100%;
            aspect-ratio: 1;
            object-fit: cover;
            display: block;
        }
        .file-info {
            padding: 10px;
            font-size: 13px;
            border-top: 1px solid #eee;
        }
        .file-name {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 5px;
        }
        .file-size {
            color: #7f8c8d;
        }
        .checkbox {
            position: absolute;
            top: 10px;
            left: 10px;
            height: 20px;
            width: 20px;
            background-color: white;
            border: 2px solid #ddd;
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1;
        }
        .file.selected .checkbox {
            background-color: #4b6bfb;
            border-color: #4b6bfb;
        }
        .checkbox:hover {
            border-color: #4b6bfb;
        }
        .file.selected .checkbox:after {
            content: "✓";
            color: white;
            font-size: 12px;
            font-weight: bold;
        }
        .empty-state {
            grid-column: 1 / -1;
            text-align: center;
            padding: 40px 0;
            color: #7f8c8d;
        }
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
            z-index: 100;
            align-items: center;
            justify-content: center;
        }
        .modal-content {
            background-color: white;
            border-radius: 8px;
            padding: 20px;
            width: 400px;
            max-width: 90%;
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        .close {
            font-size: 24px;
            cursor: pointer;
            color: #7f8c8d;
        }
        .form-group {
            margin-bottom: 15px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
        }
        .form-control {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 14px;
        }
        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 20px;
        }
        .loading {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.3);
            z-index: 200;
            align-items: center;
            justify-content: center;
        }
        .loading-spinner {
            width: 50px;
            height: 50px;
            border: 5px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: white;
            animation: spin 1s ease-in-out infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .notification {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background-color: #2ecc71;
            color: white;
            border-radius: 4px;
            box-shadow: 0 3px 10px rgba(0,0,0,0.2);
            transform: translateX(150%);
            transition: transform 0.3s ease-out;
            z-index: 300;
        }
        .notification.error {
            background-color: #e74c3c;
        }
        .notification.show {
            transform: translateX(0);
        }
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            margin-top: 30px;
            gap: 5px;
        }
        .pagination-btn {
            padding: 8px 12px;
            background-color: white;
            border: 1px solid #ddd;
            border-radius: 4px;
            cursor: pointer;
            color: #333;
            transition: all 0.2s;
        }
        .pagination-btn.active {
            background-color: #4b6bfb;
            color: white;
            border-color: #4b6bfb;
        }
        .pagination-btn:hover:not(.active) {
            background-color: #f5f5f5;
        }
        .pagination-btn.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .pagination-info {
            margin: 0 10px;
            color: #7f8c8d;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>R2管理</h1>
            <div class="header-buttons">
                <a href="/upload" class="btn">上传图片</a>
                <button id="newFolderBtn" class="btn btn-secondary">新建文件夹</button>
                <button id="deleteBtn" class="btn btn-danger" disabled>删除所选</button>
            </div>
        </div>

        <div class="breadcrumb" id="breadcrumb">
            <a href="/gallery" data-path="">首页</a>
        </div>

        <div class="gallery-controls">
            <div class="select-all-container">
                <input type="checkbox" id="selectAllCheckbox" class="select-all-checkbox">
                <label for="selectAllCheckbox">全选</label>
            </div>
        </div>

        <div class="gallery" id="gallery">
            <!-- 内容将通过JavaScript动态加载 -->
        </div>

        <div class="pagination" id="pagination">
            <!-- 分页将通过JavaScript动态加载 -->
        </div>
    </div>

    <!-- 新建文件夹的模态框 -->
    <div class="modal" id="folderModal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>新建文件夹</h3>
                <span class="close">&times;</span>
            </div>
            <div class="form-group">
                <label for="folderName">文件夹名称</label>
                <input type="text" id="folderName" class="form-control" placeholder="请输入文件夹名称">
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary close-modal">取消</button>
                <button id="createFolderBtn" class="btn">创建</button>
            </div>
        </div>
    </div>

    <!-- 加载指示器 -->
    <div class="loading" id="loading">
        <div class="loading-spinner"></div>
    </div>

    <!-- 通知提示 -->
    <div class="notification" id="notification"></div>

    <script>
        // 全局变量
        let currentPath = '';
        let selectedFiles = [];
        let currentPage = 1;
        let totalPages = 0;
        let allFiles = [];

        // 页面加载完成后执行
        document.addEventListener('DOMContentLoaded', () => {
            // 从 URL 获取当前页码
            const urlParams = new URLSearchParams(window.location.search);
            const pageParam = urlParams.get('page');
            if (pageParam && !isNaN(parseInt(pageParam))) {
                currentPage = parseInt(pageParam);
            }

            // 加载初始数据
            loadGallery();

            // 绑定事件
            document.getElementById('deleteBtn').addEventListener('click', deleteSelectedFiles);
            document.getElementById('newFolderBtn').addEventListener('click', () => showModal('folderModal'));
            document.getElementById('createFolderBtn').addEventListener('click', createFolder);
            document.getElementById('selectAllCheckbox').addEventListener('change', toggleSelectAll);

            // 关闭模态框
            const closeButtons = document.querySelectorAll('.close, .close-modal');
            closeButtons.forEach(button => {
                button.addEventListener('click', () => {
                    document.querySelectorAll('.modal').forEach(modal => {
                        modal.style.display = 'none';
                    });
                });
            });

            // 点击模态框外部关闭
			document.querySelectorAll('.modal').forEach(modal => {
				modal.addEventListener('click', (e) => {
					if (e.target instanceof Element && e.target === modal) {
						modal.style.display = 'none';
					}
				});
			});
        });

        // 加载画廊内容
        async function loadGallery() {
            showLoading(true);
            try {
                const apiUrl = '/api/list?prefix=' + encodeURIComponent(currentPath) + '&page=' + currentPage;
                const response = await fetch(apiUrl);
                const data = await response.json();

                if (data.success) {
                    // 保存全部文件列表
                    allFiles = data.files;

                    // 更新面包屑导航
                    updateBreadcrumb();

                    // 渲染文件夹和文件
                    renderGallery(data.directories, data.files);

                    // 更新分页
                    if (data.pagination) {
                        totalPages = data.pagination.totalPages;
                        renderPagination(data.pagination);
                    }

                    // 重置选中状态
                    selectedFiles = [];
                    updateDeleteButton();
                    document.getElementById('selectAllCheckbox').checked = false;
                } else {
                    showNotification('加载失败，请重试', true);
                }
            } catch (error) {
                console.error('加载失败:', error);
                showNotification('加载失败，请重试', true);
            } finally {
                showLoading(false);
            }
        }

        // 更新面包屑导航
        function updateBreadcrumb() {
            const breadcrumb = document.getElementById('breadcrumb');
            breadcrumb.innerHTML = '';

            // 添加首页链接
            const homeLink = document.createElement('a');
            homeLink.href = '/gallery';
            homeLink.textContent = '首页';
            homeLink.dataset.path = '';
            homeLink.addEventListener('click', (e) => {
                e.preventDefault();
                currentPath = '';
                currentPage = 1;
                loadGallery();
            });
            breadcrumb.appendChild(homeLink);

            // 如果当前不在首页，则添加路径
            if (currentPath) {
                const pathParts = currentPath.split('/').filter(p => p);
                let path = '';

                pathParts.forEach((part, index) => {
                    // Build cumulative path
                    if (index === 0) {
                        path = part;
                    } else {
                        path += '/' + part;
                    }

                    // 添加分隔符
                    const separator = document.createElement('span');
                    separator.className = 'separator';
                    separator.textContent = ' / ';
                    breadcrumb.appendChild(separator);

                    // 添加路径链接
                    const link = document.createElement('a');
                    link.href = path;
                    link.textContent = part;
                    link.dataset.path = path;

                    // 如果是最后一部分，则不添加点击事件
                    if (index === pathParts.length - 1) {
                        link.style.color = '#333';
                        link.style.textDecoration = 'none';
                        link.style.pointerEvents = 'none';
                    } else {
                        // Create a closure to capture the current path value
                        const currentPathValue = path;
                        link.addEventListener('click', (e) => {
                            e.preventDefault();
                            currentPath = currentPathValue+"/";
                            currentPage = 1;
                            loadGallery();
                        });
                    }
                    breadcrumb.appendChild(link);
                });
            }
        }

        // 渲染画廊内容
        function renderGallery(directories, files) {
            const gallery = document.getElementById('gallery');
            gallery.innerHTML = '';

            // 渲染文件夹
            directories.forEach(dir => {
                const dirElement = document.createElement('div');
                dirElement.className = 'item directory';
                dirElement.addEventListener('click', () => {
                    currentPath = dir.path;
                    currentPage = 1;
                    loadGallery();
                });

                dirElement.innerHTML = '<div class="directory-icon">📁</div>' +
                    '<div class="file-name">' + dir.name + '</div>';

                gallery.appendChild(dirElement);
            });

            // 渲染文件
			files.forEach(file => {
				const fileElement = document.createElement('div');
				fileElement.className = 'item file';
				fileElement.dataset.key = file.key;

				// 如果文件名是 .null，显示文件图标而非图片
				if (file.name === '.null') {
                    fileElement.className = 'item file directory';
					fileElement.innerHTML = '<div class="checkbox"></div>' +
						'<div class="directory-icon">📄</div>' +
						'<div class="file-info">' +
						'<div class="file-name">NULL</div>' +
						'</div>';
				} else {
					fileElement.innerHTML = '<div class="checkbox"></div>' +
						'<img src="' + file.url + '" alt="' + file.name + '" class="file-image">' +
						'<div class="file-info">' +
						'<div class="file-name">' + file.name + '</div>' +
						'<div class="file-size">' + formatFileSize(file.size) + '</div>' +
						'</div>';
				}

				// 添加选择事件
				const checkbox = fileElement.querySelector('.checkbox');
				checkbox.addEventListener('click', (e) => {
					e.stopPropagation();
					toggleFileSelection(fileElement, file.key);
				});

				// 点击图片区域也可以选择
				fileElement.addEventListener('click', () => {
					toggleFileSelection(fileElement, file.key);
				});

				gallery.appendChild(fileElement);
			});

            // 如果没有内容，显示空状态
            if (directories.length === 0 && files.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.textContent = '当前文件夹为空';
                gallery.appendChild(emptyState);
            }

            // 显示或隐藏全选控件
            document.querySelector('.select-all-container').style.display = files.length > 0 ? 'flex' : 'none';
        }

        // 渲染分页控件
        function renderPagination(pagination) {
            const paginationElement = document.getElementById('pagination');
            paginationElement.innerHTML = '';

            // 如果总页数小于等于1，不显示分页
            if (pagination.totalPages <= 1) {
                paginationElement.style.display = 'none';
                return;
            }

            paginationElement.style.display = 'flex';

            // 上一页按钮
            const prevButton = document.createElement('button');
            prevButton.className = 'pagination-btn ' + (currentPage === 1 ? 'disabled' : '');
            prevButton.textContent = '上一页';
            if (currentPage > 1) {
                prevButton.addEventListener('click', () => changePage(currentPage - 1));
            }
            paginationElement.appendChild(prevButton);

            // 页码按钮
            const maxVisiblePages = 5;
            let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
            let endPage = Math.min(pagination.totalPages, startPage + maxVisiblePages - 1);

            // 调整起始页以确保显示足够的页码
            if (endPage - startPage + 1 < maxVisiblePages) {
                startPage = Math.max(1, endPage - maxVisiblePages + 1);
            }

            // 第一页按钮
            if (startPage > 1) {
                const firstPageBtn = document.createElement('button');
                firstPageBtn.className = 'pagination-btn';
                firstPageBtn.textContent = '1';
                firstPageBtn.addEventListener('click', () => changePage(1));
                paginationElement.appendChild(firstPageBtn);

                if (startPage > 2) {
                    const ellipsis = document.createElement('span');
                    ellipsis.className = 'pagination-info';
                    ellipsis.textContent = '...';
                    paginationElement.appendChild(ellipsis);
                }
            }

            // 页码按钮
            for (let i = startPage; i <= endPage; i++) {
                const pageBtn = document.createElement('button');
                pageBtn.className = 'pagination-btn ' + (i === currentPage ? 'active' : '');
                pageBtn.textContent = String(i);
                pageBtn.addEventListener('click', () => changePage(i));
                paginationElement.appendChild(pageBtn);
            }

            // 最后一页按钮
            if (endPage < pagination.totalPages) {
                if (endPage < pagination.totalPages - 1) {
                    const ellipsis = document.createElement('span');
                    ellipsis.className = 'pagination-info';
                    ellipsis.textContent = '...';
                    paginationElement.appendChild(ellipsis);
                }

                const lastPageBtn = document.createElement('button');
                lastPageBtn.className = 'pagination-btn';
                lastPageBtn.textContent = pagination.totalPages;
                lastPageBtn.addEventListener('click', () => changePage(pagination.totalPages));
                paginationElement.appendChild(lastPageBtn);
            }

            // 下一页按钮
            const nextButton = document.createElement('button');
            nextButton.className = 'pagination-btn ' + (currentPage === pagination.totalPages ? 'disabled' : '');
            nextButton.textContent = '下一页';
            if (currentPage < pagination.totalPages) {
                nextButton.addEventListener('click', () => changePage(currentPage + 1));
            }
            paginationElement.appendChild(nextButton);
        }

        // 切换页码
        function changePage(page) {
            if (page === currentPage) return;

            currentPage = page;

            // 更新 URL 参数
            const url = new URL(window.location);
            url.searchParams.set('page', currentPage);
            window.history.pushState({}, '', url);

            // 重新加载画廊
            loadGallery();
        }

        // 切换文件选择状态
        function toggleFileSelection(element, key) {
            const index = selectedFiles.indexOf(key);

            if (index === -1) {
                // 添加到选中列表
                selectedFiles.push(key);
                element.classList.add('selected');
            } else {
                // 从选中列表中移除
                selectedFiles.splice(index, 1);
                element.classList.remove('selected');
            }

            // 更新删除按钮状态
            updateDeleteButton();

            // 更新全选状态
            updateSelectAllCheckbox();
        }

        // 全选/取消全选
        function toggleSelectAll() {
            const selectAllCheckbox = document.getElementById('selectAllCheckbox');
            const isChecked = selectAllCheckbox.checked;

            // 获取所有文件元素
            const fileElements = document.querySelectorAll('.file');

            if (isChecked) {
                // 全选
                selectedFiles = [];
                fileElements.forEach(fileElement => {
                    const key = fileElement.dataset.key;
                    if (!selectedFiles.includes(key)) {
                        selectedFiles.push(key);
                        fileElement.classList.add('selected');
                    }
                });
            } else {
                // 取消全选
                selectedFiles = [];
                fileElements.forEach(fileElement => {
                    fileElement.classList.remove('selected');
                });
            }

            // 更新删除按钮状态
            updateDeleteButton();
        }

        // 更新全选复选框状态
        function updateSelectAllCheckbox() {
            const selectAllCheckbox = document.getElementById('selectAllCheckbox');
            const fileElements = document.querySelectorAll('.file');

            // 如果没有文件，则禁用全选
            if (fileElements.length === 0) {
                selectAllCheckbox.checked = false;
                return;
            }

            // 检查是否所有文件都被选中
            selectAllCheckbox.checked = selectedFiles.length === fileElements.length;
        }

        // 更新删除按钮状态
        function updateDeleteButton() {
            const deleteBtn = document.getElementById('deleteBtn');
            deleteBtn.disabled = selectedFiles.length === 0;
        }

        // 删除选中的文件
        async function deleteSelectedFiles() {
            if (selectedFiles.length === 0) return;

            if (!confirm('确定要删除选中的 ' + selectedFiles.length + ' 个文件吗？')) {
                return;
            }

            showLoading(true);

            try {
                const response = await fetch('/api/delete', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        'keys': selectedFiles
                    })
                });

                const data = await response.json();

                if (data.success) {
                    showNotification('删除成功');
                    await loadGallery(); // 重新加载画廊
                } else {
                    showNotification('删除失败，请重试', true);
                }
            } catch (error) {
                console.error('删除失败:', error);
                showNotification('删除失败，请重试', true);
            } finally {
                showLoading(false);
            }
        }

        // 创建新文件夹
        async function createFolder() {
            const folderNameInput = document.getElementById('folderName');
            const folderName = folderNameInput.value.trim();

            if (!folderName) {
                alert('请输入文件夹名称');
                return;
            }

            showLoading(true);

            try {
                const path = currentPath ? currentPath + folderName + '/' : folderName + '/';

                const response = await fetch('/api/create-folder', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ path })
                });

                const data = await response.json();

                if (data.success) {
                    showNotification('文件夹创建成功');
                    document.getElementById('folderModal').style.display = 'none';
                    folderNameInput.value = '';
                    await loadGallery(); // 重新加载画廊
                } else {
                    showNotification('文件夹创建失败，请重试', true);
                }
            } catch (error) {
                console.error('文件夹创建失败:', error);
                showNotification('文件夹创建失败，请重试', true);
            } finally {
                showLoading(false);
            }
        }

        // 显示模态框
        function showModal(id) {
            const modal = document.getElementById(id);
            modal.style.display = 'flex';

            // 如果是文件夹模态框，聚焦输入框
            if (id === 'folderModal') {
                setTimeout(() => {
                    document.getElementById('folderName').focus();
                }, 100);
            }
        }

        // 显示/隐藏加载指示器
        function showLoading(show) {
            const loading = document.getElementById('loading');
            loading.style.display = show ? 'flex' : 'none';
        }

        // 显示通知
        function showNotification(message, isError = false) {
            const notification = document.getElementById('notification');
            notification.textContent = message;
            notification.className = isError ? 'notification error' : 'notification';

            // 显示通知
            setTimeout(() => {
                notification.classList.add('show');
            }, 10);

            // 3秒后隐藏
            setTimeout(() => {
                notification.classList.remove('show');
            }, 3000);
        }

        // 格式化文件大小
        function formatFileSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }
    </script>
</body>
</html>
    `;

	return new Response(html, {
		headers: {'Content-Type': 'text/html; charset=utf-8'}
	});
}

async function handleWebUpload(request, bucket, baseUrl) {
	try {
		// Parse the form data
		const formData = await request.formData();
		const file = formData.get('file');
		const path = formData.get('path') || '';

		if (!file) {
			return new Response(JSON.stringify({
				success: false,
				message: "No file provided"
			}), {
				status: 400,
				headers: {'Content-Type': 'application/json'}
			});
		}

		// Process file data
		const fileBuffer = await file.arrayBuffer();
		const uint8Array = new Uint8Array(fileBuffer);

		// Detect file type
		const detectedType = detectImageType(uint8Array);
		if (!detectedType) {
			return new Response(JSON.stringify({
				success: false,
				message: "Only JPG/PNG formats are supported"
			}), {
				status: 400,
				headers: {'Content-Type': 'application/json'}
			});
		}

		// Generate file name with date prefix and UUID
		const date = new Date();
		const formattedDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
		const shortUUID = crypto.randomUUID().split('-')[0];

		// Build file path with user prefix if provided
		let key = `${formattedDate}_${shortUUID}.${detectedType.ext}`;
		if (path) {
			// Ensure path has trailing slash
			const formattedPath = path.endsWith('/') ? path : `${path}/`;
			key = `${formattedPath}${key}`;
		}

		// Upload to R2
		await bucket.put(key, fileBuffer, {
			httpMetadata: {
				contentType: detectedType.mime
			}
		});

		// Generate URLs for response
		const imageUrl = `${baseUrl}/${key}`;

		return new Response(JSON.stringify({
			success: true,
			url: imageUrl,
			markdown: `![img](${imageUrl})`,
			key: key
		}), {
			headers: {'Content-Type': 'application/json'}
		});

	} catch (error) {
		console.error('Upload failed:', error);
		return new Response(JSON.stringify({
			success: false,
			message: "File upload failed, please try again."
		}), {
			status: 500,
			headers: {'Content-Type': 'application/json'}
		});
	}
}

async function handleListFiles(request, bucket) {
	try {
		const url = new URL(request.url);
		const prefix = url.searchParams.get('prefix') || '';
		const delimiter = '/';

		// Get pagination parameters
		const page = parseInt(url.searchParams.get('page') || '1', 10); // Default to page 1
		const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10); // Default to 50 items per page

		// List objects with the given prefix
		const listResult = await bucket.list({
			prefix: prefix,
			delimiter: delimiter
		});

		// Format directories (commonPrefixes) and files (objects)
		const directories = (listResult.delimitedPrefixes || []).map(delimitedPrefixes => {
			const name = delimitedPrefixes.substring(prefix.length).replace(/\/$/, '');
			return {
				name: name,
				path: delimitedPrefixes,
				type: 'directory'
			};
		});

		const files = (listResult.objects || []).map(object => {
			// Skip objects that represent the current directory or are used as directory markers
			if (object.key === prefix) {
				return null;
			}

			// For actual files, extract just the filename from the full path
			const name = object.key.substring(prefix.length);
			if (!name) return null; // Skip if name is empty

			return {
				name: name,
				key: object.key,
				size: object.size,
				uploaded: object.uploaded,
				type: 'file',
				url: `${BASE_URL}/${encodeURIComponent(object.key)}`
			};
		}).filter(file => file !== null);

		// Implement pagination
		const totalFiles = files.length;
		const totalPages = Math.ceil(totalFiles / pageSize);

		// Calculate starting index for the current page
		const startIndex = (page - 1) * pageSize;
		const endIndex = Math.min(startIndex + pageSize, totalFiles); // Ensure we don't exceed the array length
		const filesOnPage = files.slice(startIndex, endIndex);

		// Calculate parent directory path
		let parentPath = '';
		if (prefix) {
			const parts = prefix.split('/');
			parts.pop(); // Remove the last part (empty if prefix ends with /)
			if (parts.length > 0) {
				parts.pop(); // Remove the directory name
				parentPath = parts.join('/');
				if (parentPath) parentPath += '/';
			}
		}

		return new Response(JSON.stringify({
			success: true,
			currentPath: prefix,
			parentPath: parentPath,
			directories: directories,
			files: filesOnPage,
			pagination: {
				currentPage: page,
				pageSize: pageSize,
				totalFiles: totalFiles,
				totalPages: totalPages
			}
		}), {
			headers: {'Content-Type': 'application/json'}
		});

	} catch (error) {
		console.error('List files error:', error);
		return new Response(JSON.stringify({
			success: false,
			message: 'Failed to list files'
		}), {
			status: 500,
			headers: {'Content-Type': 'application/json'}
		});
	}
}


async function handleDeleteFiles(request, bucket) {
	try {
		console.log("Request received");
		const body = await request.json();
		console.log("Body parsed", body);
		const keys = body.keys;
		if (!keys || !Array.isArray(keys) || keys.length === 0) {
			console.log("No valid keys provided");
			return new Response(JSON.stringify({
				success: false,
				message: "No valid keys provided for deletion"
			}), {
				status: 400,
				headers: {'Content-Type': 'application/json'}
			});
		}
		const deletePromises = keys.map(key => bucket.delete(key));
		await Promise.all(deletePromises);
		console.log(`${keys.length} files deleted`);

		return new Response(JSON.stringify({
			success: true,
			message: `Successfully deleted ${keys.length} file(s)`,
			deletedKeys: keys
		}), {
			headers: {'Content-Type': 'application/json'}
		});
	} catch (error) {
		console.error('Delete files error:', error);
		return new Response(JSON.stringify({
			success: false,
			message: 'Failed to delete files'
		}), {
			status: 500,
			headers: {'Content-Type': 'application/json'}
		});
	}
}


async function handleCreateFolder(request, bucket) {
	try {
		// Parse the JSON body to get the folder path
		const body = await request.json();
		let folderPath = body.path;

		if (!folderPath) {
			return new Response(JSON.stringify({
				success: false,
				message: "Folder path is required"
			}), {
				status: 400,
				headers: {'Content-Type': 'application/json'}
			});
		}

		// Ensure the folder path ends with a slash
		if (!folderPath.endsWith('/')) {
			folderPath += '/';
		}

		// Create a .null file to represent the folder (a common practice in S3/R2)
		// This isn't strictly necessary but helps with empty folders
		const nullPath = `${folderPath}.null`;
		await bucket.put(nullPath, new Uint8Array(0), {
			httpMetadata: {
				contentType: 'application/x-directory'
			}
		});

		return new Response(JSON.stringify({
			success: true,
			message: "Folder created successfully",
			path: folderPath
		}), {
			headers: {'Content-Type': 'application/json'}
		});
	} catch (error) {
		console.error('Create folder error:', error);
		return new Response(JSON.stringify({
			success: false,
			message: 'Failed to create folder'
		}), {
			status: 500,
			headers: {'Content-Type': 'application/json'}
		});
	}
}



async function uploadImageToR2(imageUrl, bucket, isDocument = false, userPath = '') {
	try {
		const response = await fetch(imageUrl);
		if (!response.ok) throw new Error('下载文件失败');

		const buffer = await response.arrayBuffer();
		const uint8Array = new Uint8Array(buffer);

		const detectedType = detectImageType(uint8Array);
		if (!detectedType) {
			return {
				ok: false,
				error: 'UNSUPPORTED_TYPE',
				message: '只支持 JPG/PNG 格式文件'
			};
		}
		const date = new Date();
		const formattedDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
		const shortUUID = crypto.randomUUID().split('-')[0];

		// Build file path with user prefix if provided
		let key = `${formattedDate}_${shortUUID}.${detectedType.ext}`;
		if (userPath) {
			// Ensure path format is correct (has trailing slash)
			const formattedPath = userPath.endsWith('/') ? userPath : `${userPath}/`;
			key = `${formattedPath}${key}`;
		}

		await bucket.put(key, buffer, {
			httpMetadata: {
				contentType: detectedType.mime
			},
		});

		return {ok: true, key};
	} catch (error) {
		console.error('上传失败:', error);
		return {
			ok: false,
			error: 'SERVER_ERROR',
			message: '文件上传失败，请稍后再试。'
		};
	}
}

async function getFileUrl(fileId, botToken) {
	const response = await fetch(
		`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
	);
	const data = await response.json();
	return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
}

async function sendMessage(chatId, text, apiUrl, options = {}) {
	await fetch(`${apiUrl}/sendMessage`, {
		method: 'POST',
		headers: {'Content-Type': 'application/json'},
		body: JSON.stringify({
			chat_id: chatId,
			text: text,
			...options
		}),
	});
}

async function sendPhoto(chatId, photoUrl, apiUrl, caption = "", options = {}) {
	const response = await fetch(`${apiUrl}/sendPhoto`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			chat_id: chatId,
			photo: photoUrl,
			caption: caption,
			...options
		}),
	});
	return await response.json();
}
