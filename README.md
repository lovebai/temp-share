# TempShare

限时文件分享工具 — 上传文件生成临时下载链接，到期自动过期并删除。

## 功能

- **验证码保护** — 上传前需输入 6 位数字验证码
- **提取码分享** — 上传后生成独立提取码，对方凭码即可提取文件
- **双模式界面** — 上传 / 提取切换，均可复制对应 `curl` 命令
- **多种上传方式** — 拖拽、`Ctrl+V` 粘贴、终端 `curl` 命令
- **灵活有效期** — 5 分钟 / 15 分钟 / 30 分钟 / 1 小时 / 6 小时 / 12 小时 / 24 小时
- **下载链接二维码** — 上传成功后自动生成二维码，扫码即可下载
- **自动清理** — 每 30 秒检查一次，过期文件自动删除
- **美化错误页** — 文件失效展示定制 ghost 页面，未知路由展示独立 404 页面
- **终端友好** — 提供完整的 `curl` 上传和下载命令

## 快速开始

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

启动后访问 `http://localhost:3000`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TS_PORT` | `3000` | 服务端口 |
| `TS_DATA_DIR` | 项目根目录 | 上传文件与元数据存储路径 |
| `TS_MAX_SIZE` | `50` | 单文件上传上限（MB） |

示例：

```bash
# 自定义端口和文件大小上限
TS_PORT=8080 TS_MAX_SIZE=200 npm start

# 指定数据目录
TS_DATA_DIR=/data/tempshare npm start
```

## API

### `POST /api/code`

生成 6 位数字验证码，有效期 5 分钟。

**响应**

```json
{
  "code": "374829",
  "expiresIn": 300
}
```

### `POST /api/validate`

校验验证码是否有效。

**请求**

```json
{
  "code": "374829"
}
```

**响应**

```json
{
  "valid": true
}
```

### `POST /api/upload`

上传文件。

- Content-Type: `multipart/form-data`

| 字段 | 类型 | 说明 |
|------|------|------|
| `file` | File | 文件 |
| `code` | string | 6 位验证码 |
| `expiry` | string | 有效期，可选值：`5m` `15m` `30m` `1h` `6h` `12h` `24h` |

**响应**

```json
{
  "id": "3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e",
  "extractCode": "482913",
  "url": "/api/download/3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e",
  "originalName": "report.pdf",
  "size": 1048576,
  "expiresAt": 1752723240000,
  "expiry": "30m"
}
```

**终端上传示例**

```bash
curl -X POST http://localhost:3000/api/upload \
  -F "file=@/path/to/your/file.pdf" \
  -F "code=374829" \
  -F "expiry=30m"
```

### `GET /api/download/:id`

下载文件。若文件不存在返回 `404`，若已过期返回 `410`，均展示美化后的失效提示页。

**终端下载示例**

```bash
curl -O http://localhost:3000/api/download/3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e
```

### `POST /api/retrieve`

凭提取码获取文件下载信息。

**请求**

```json
{
  "code": "482913"
}
```

**响应**

```json
{
  "id": "3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e",
  "extractCode": "482913",
  "url": "/api/download/3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e",
  "originalName": "report.pdf",
  "size": 1048576,
  "expiresAt": 1752723240000,
  "remaining": 1745000,
  "expiry": "30m"
}
```

**终端提取示例**

```bash
curl -X POST http://localhost:3000/api/retrieve \
  -H "Content-Type: application/json" \
  -d '{"code":"482913"}'
```

### `GET /api/info/:id`

查询文件信息（不含文件内容）。

**响应**

```json
{
  "id": "3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e",
  "originalName": "report.pdf",
  "size": 1048576,
  "expiresAt": 1752723240000,
  "remaining": 1745000
}
```

### `GET /api/qr`

生成二维码图片（`?text=` 指定内容），返回 PNG。

### 其他

- 未知 `/api/*` 请求返回 `404` JSON 错误
- 未知页面路径返回独立 `404.html` 页面

## 项目结构

```
temp-share/
├── server.js          # Express 后端
├── public/
│   ├── index.html     # 前端页面（独立，零外部依赖）
│   ├── error.html     # 文件失效提示页（404 / 410）
│   ├── 404.html       # 未知路由 404 页面
│   └── favicon.svg    # 站点图标
├── uploads/           # 上传的文件（.gitignore）
├── metadata/          # 文件元数据 JSON（.gitignore）
├── package.json
└── README.md
```

## 技术栈

- **后端** — Node.js + Express + multer + uuid + qrcode
- **前端** — 原生 HTML/CSS/JS，JetBrains Mono 等宽字体，暗色终端风格
- **二维码** — 本地 `qrcode` 库生成下载链接二维码

## 链接

- **GitHub** — https://github.com/lovebai/temp-share
- **博客** — https://bducds.de/
