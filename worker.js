// Created by rocket, the author of 111666.best
// Original link: https://www.nodeseek.com/post-170862-1
// 2025-04-07修改
// https://github.com/xinycai/
const TELEGRAM_BOT_TOKEN = "76xxxxxxx:AAHxxxxxxxxxxxxxxxxxxxRXdOUzJQ"; //填入TG机器人token
const CHAT_ID = ["5xxxxxx63"]; // 填入可以访问机器人的用户ID，可以填入多个["xxxxxxxxx", "xxxxxxxx"]
const BUCKET_NAME = "xxxxx"; // 填入绑定的R2存储库变量名
const BASE_URL = "https://xxxxxx.xx" // 填入自己的R2的访问域名，如果反向代理了R2，可以填入反向代理的域名
export default {
    async fetch(request, env) {

        const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
        const url = new URL(request.url);

        // 获取用户的当前路径
        async function getUserPath(chatId) {
            const path = await env.INDEXES_KV.get(chatId.toString());
            if (path == '/'){
                return '';
            }
            return path || ''; // 默认为空字符串，对应根路径
        }

        // 设置用户的路径
        async function setUserPath(chatId, path) {
            await env.INDEXES_KV.put(chatId.toString(), path);
        }

        async function handleMediaUpload(chatId, fileId, isDocument = false) {
            try {
                await sendMessage(chatId, '收到文件，正在上传ing', TELEGRAM_API_URL);

                const fileUrl = await getFileUrl(fileId, TELEGRAM_BOT_TOKEN);
                const userPath = await getUserPath(chatId);
                const uploadResult = await uploadImageToR2(fileUrl, env[BUCKET_NAME], isDocument, userPath);

                if (uploadResult.ok) {
                    const imageUrl = `${BASE_URL}/${uploadResult.key}`;
                    const caption = `✅ 图片上传成功！\n直链\n<code>${imageUrl}</code>\nMarkdown\n<code>![img](${imageUrl})</code>`;
                    await sendPhoto(chatId, imageUrl, TELEGRAM_API_URL, caption, { parse_mode: "HTML" });
                } else {
                    await sendMessage(chatId, uploadResult.message, TELEGRAM_API_URL);
                }
            } catch (error) {
                console.error('处理文件失败:', error);
                await sendMessage(chatId, '文件处理失败，请稍后再试。', TELEGRAM_API_URL);
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
                
                // 构建文件路径，添加用户指定的路径前缀
                let key = `${formattedDate}_${shortUUID}.${detectedType.ext}`;
                if (userPath) {
                    // 确保路径格式正确（末尾有斜杠）
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

        // 设置 Webhook
        if (url.pathname === '/setWebhook') {
            const webhookUrl = `${url.protocol}//${url.host}/webhook`;
            const webhookResponse = await setWebhook(webhookUrl, TELEGRAM_API_URL);
            if (webhookResponse.ok) {
                return new Response(`Webhook set successfully to ${webhookUrl}`);
            }
            return new Response('Failed to set webhook', {status: 500});
        }

        if (url.pathname === '/webhook' && request.method === 'POST') {
            try {
                console.log("1");
                const update = await request.json();

                if (!update.message) return new Response('OK');

                const chatId = update.message.chat.id;

                if (!CHAT_ID.includes(chatId.toString())) {
                    return new Response('Unauthorized access', { status: 403 });
                }
                console.log(update);
                // 处理文本消息
                if (update.message.text) {
                    const text = update.message.text.trim();
                    
                    // 处理 /modify 命令
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
                    
                    // 处理 /status 命令
                    if (text === '/status') {
                        const currentPath = await getUserPath(chatId);
                        const statusMessage = currentPath ? `当前路径: ${currentPath}` : '当前路径: / (默认)';
                        await sendMessage(chatId, statusMessage, TELEGRAM_API_URL);
                        return new Response('OK');
                    }

                    let mes = `请发送一张图片！\n或者使用以下命令：\n/modify 修改上传图片的存储路径\n/status 查看当前上传图片的路径`;
                    
                    await sendMessage(chatId, mes, TELEGRAM_API_URL);
                    return new Response('OK');
                }

                // 处理文档文件
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

        return new Response('Not found', {status: 404});
    },
};

function detectImageType(uint8Array) {
    // 检测 JPEG (FF D8 FF)
    if (uint8Array.length >= 3 &&
        uint8Array[0] === 0xFF &&
        uint8Array[1] === 0xD8 &&
        uint8Array[2] === 0xFF) {
        return {mime: 'image/jpeg', ext: 'jpg'};
    }

    // 检测 PNG (89 50 4E 47 0D 0A 1A 0A)
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (uint8Array.length >= pngSignature.length) {
        const isPng = pngSignature.every(
            (byte, index) => uint8Array[index] === byte
        );
        if (isPng) return {mime: 'image/png', ext: 'png'};
    }

    return null;
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

async function setWebhook(webhookUrl, apiUrl) {
    const response = await fetch(`${apiUrl}/setWebhook`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: webhookUrl}),
    });
    return response.json();
}
