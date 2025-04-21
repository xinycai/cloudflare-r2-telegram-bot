
图床存储在R2存储桶中，提供免费的10GB容量，个人用户足够使用。配置了缓存规则，因此不需要担心刷读取次数问题。无需使用服务器，避免了运维成本。支持上传 JPG 和 PNG 格式的图片，并且支持从 Telegram 发送原图。
增加web管理界面，可进行图片删除，新增文件夹，上传等操作。
### 特性
#### 1.支持web管理
#### 2.支持新增文件夹
#### 3.支持从TG机器人自定义上传路径
#### 4.支持一键复制


### 预览

![img](https://r2.wuxie.de/blog/20250421_056f65e8.jpg)
![img](https://r2.wuxie.de/blog/20250421_d1067722.jpg)
![img](https://r2.wuxie.de/blog/20250421_5457937c.jpg)
![img](https://r2.wuxie.de/blog/20250421_80871627.jpg)
![img](https://r2.wuxie.de/blog/20250421_b948a084.jpg)
![img](https://r2.wuxie.de/blog/20250421_131cbad6.jpg)
![img](https://r2.wuxie.de/blog/20250421_1aba91c6.jpg)
![img](https://r2.wuxie.de/blog/20250421_732e1541.jpg)

---

### 步骤指南

#### 第一步：获取 Telegram 机器人 Token 和用户 ChatID
- 参考链接：[获取 Telegram 机器人 Token 和 Chat ID](https://blog.xiny.cc/archives/mTaUz0TW)

#### 第二步：创建 R2 存储桶
1. 访问 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 创建一个 R2 存储桶，名字可以随意设置，完成后添加一个域名。

#### 第三步：创建 Cloudflare Worker
1. 在 Cloudflare 中创建一个空白 Worker，名字可以随意设置。

#### 第四步：创建 KV 数据库
1. 在 Cloudflare 左侧找到存储与数据库，创建一个KV数据库，名字可以随意设置。

#### 第五步：绑定 R2 存储桶
1. 在 Cloudflare Worker 的设置中，选择绑定 R2 存储桶，名称可以随意设置。
   
   ![R2存储桶绑定](https://r2.wuxie.de/blog/20250407_b83841fc.jpg)

#### 第六步：绑定 kv 数据库
1. 在 Cloudflare Worker 的设置中，选择绑定 kv 数据库，名称需要为 INDEXES_KV。
    ![img](https://r2.wuxie.de/blog/20250418_8a989a87.jpg)
#### 第五步：编辑 Worker 代码
1. 复制完整的 Worker 代码，然后编辑替换以下变量为对应的值：
   - `SECRET_KEY`：填入web访问管理的密码。
   - `TELEGRAM_BOT_TOKEN`：填入你的 Telegram 机器人 Token。
   - `CHAT_ID`：填入可以访问机器人的用户 ID（可以填多个）。
   - `BUCKET_NAME`：填入你绑定的 R2 存储桶变量名。
   - `BASE_URL`：填入你的 R2 存储桶访问域名。如果使用反向代理，可以填入反向代理的域名。
   
3. 完整的 Worker 放在github
   [点击去查看代码](https://github.com/xinycai/cloudflare-r2-telegram-bot/blob/main/worker.js)


#### 第六步：设置 Webhook
1. 访问 `https://你的worker域名/setWebhook` 完成设置。
2. 现在你可以访问你的 Telegram 机器人，开始使用图床功能了。

