# LLM WebChat

零依赖（只需 Node.js ≥ 18）的网页聊天，后端转发任意 OpenAI 兼容接口，API Key 只存在服务器上。

## 功能
- 聊天页 `/`：流式输出、Markdown/代码块、模型下拉切换、停止生成、新对话（记录存在浏览器本地）
- 设置页 `/admin`：多个模型服务商（各自 Base URL / Key / 模型；协议支持 OpenAI 兼容、Anthropic/Claude、Google Gemini 原生、云知声 SystemOne 决策模型；Anthropic/Gemini 流式会在后端转换为 OpenAI 格式）、默认模型、系统提示词、Temperature、访问口令、在线修改管理员密码（scrypt 哈希存 config.json，优先于 ADMIN_PASSWORD）
- 多模态：📎 / 粘贴 / 拖拽上传；图片以 image_url 发送；PDF、Word、Excel、PPT、文本自动提取文字；视频抽帧成图片（或发送视频链接）；模型不支持图片时自动降级为纯文字
- 输出：Markdown 图片带下载按钮、文件附件可下载、思考过程（reasoning_content）折叠显示
- 悬浮挂件：`<script src="https://你的域名/widget.js" data-title="在线助手" data-color="#2563eb" defer></script>`，演示页 `/widget-demo.html`
- 依赖（可选）：`pdftotext`（poppler-utils）读 PDF，`ffmpeg` 视频抽帧，`unzip` 读 Office 文档
- 配置保存在 `config.json`（权限 600），Key 不会下发到浏览器

## 启动
```bash
cd llm-webchat
ADMIN_PASSWORD='改成你的密码' PORT=3000 node server.js
```
打开 `http://服务器IP:3000/admin` 登录并填写接口，然后访问 `http://服务器IP:3000/` 聊天。

常见 Base URL：
- OpenAI：`https://api.openai.com/v1`
- DeepSeek：`https://api.deepseek.com/v1`
- 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- Moonshot：`https://api.moonshot.cn/v1`
- 本地 Ollama：`http://127.0.0.1:11434/v1`

## 后台常驻（systemd）
`/etc/systemd/system/webchat.service`：
```ini
[Unit]
Description=LLM WebChat
After=network.target

[Service]
WorkingDirectory=/opt/llm-webchat
Environment=ADMIN_PASSWORD=改成你的密码
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now webchat
```
（或用 pm2：`ADMIN_PASSWORD=xxx pm2 start server.js --name webchat`）

## Nginx 反代 + HTTPS（推荐）
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;        # 流式输出必须关闭缓冲
    proxy_read_timeout 300s;
}
```
挂在子路径（如 `/chat/`）也可以：`location /chat/ { proxy_pass http://127.0.0.1:3000/; ... }`，页面里的请求都是相对路径。

## 嵌入到其它网页
```html
<iframe src="https://你的域名/" style="width:400px;height:600px;border:0"></iframe>
```

## 安全建议
- 一定设置强 `ADMIN_PASSWORD`，并走 HTTPS
- 对外公开时建议在设置页开启“访问口令”，避免 Key 额度被别人刷

## 部署参考（deploy/ 目录）
- `deploy/hark-webchat.service`：systemd 服务，复制到 `/etc/systemd/system/` 后 `systemctl enable --now hark-webchat`
- `deploy/nginx-hark-webchat.conf`：Nginx 反代 + HTTPS 配置，放到 `/etc/nginx/conf.d/`
- 运行时配置（含 API Key、管理员密码哈希）保存在程序目录下的 `config.json`，不包含在源码包中，请勿外传
