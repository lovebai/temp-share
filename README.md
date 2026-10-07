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
- **上传检查** — 页面读取服务器大小限制，选择超限文件立即提示；上传失败可重试
- **过期状态** — 提取结果过期后禁用下载按钮
- **批量分享** — 一次最多上传 20 个文件，每个文件独立生成提取码，可分别下载和删除
- **取消上传** — 上传中可以取消，失败或取消的临时文件会清理
- **分享信息** — 一键复制文件名、提取码、提取链接、下载链接和有效期；剪贴板不可用时提供手动复制
- **下载次数** — 可选不限次数、1 / 3 / 5 / 10 次，达到上限后停止下载和提取
- **提前删除** — 上传成功页面提供独立删除凭证，确认后立即使分享失效；刷新或关闭页面后不再保留删除权限
- **容量与限流** — 总容量默认 1 GB，限制验证码、上传、提取、二维码和删除接口的访问频率
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
| `TS_MAX_TOTAL_MB` | `1024` | 全部分享文件的总容量上限（MB） |
| `TS_TRUST_PROXY` | 不启用 | 可信反向代理 IP / 子网列表，如 `loopback`；通过代理部署时按实际网络配置，以便按客户端 IP 限流 |

示例：

```bash
# 自定义端口和文件大小上限
TS_PORT=8080 TS_MAX_SIZE=200 npm start

# 指定数据目录
TS_DATA_DIR=/data/tempshare npm start
```

## API

### 新增接口与字段

- `GET /api/config`：返回 `maxSize`、`maxTotal`（字节）及 `maxFiles`。
- `POST /api/upload-batch`：以多个 `files` 字段上传，其他字段同单文件上传，返回 `{ files: [...] }`。整批失败时撤销已经写入的文件。
- 上传可携带 `maxDownloads`，`0` 表示不限次数，允许 `0` 至 `10000` 的整数。
- 上传响应额外返回 `deleteToken`，提取与查询接口不会返回该凭证。使用 `DELETE /api/files/:id`，在 `X-Delete-Token` 请求头中提供凭证，可提前删除。
- 响应包含 `maxDownloads`、`downloads`、`remainingDownloads`（不限次数时为 `null`）。次数按下载请求计数，失败时退还；受限文件不支持分段下载，HEAD 查询不计数。
- `/?code=123456` 打开提取页面并自动填入提取码，用户点击“提取”查看文件。
- 每个 IP 每分钟限额：生成验证码 20、校验 30、提取 30、上传 10、二维码 60、删除 20。超限返回 `429` 和 `Retry-After`。
- 单文件超限返回 `413`；总容量不足返回 `507`；下载次数耗尽返回 `410`。
- 到期文件每 30 秒清理；无元数据的残留文件在启动及定期检查时清理，正在上传的文件除外。达到下载次数上限的文件保留到原定到期时间，上传者也可提前删除。

验证功能：运行 `npm test`。测试使用独立临时目录，不访问现有分享文件。

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
curl --fail --show-error --location --remote-name --remote-header-name http://localhost:3000/api/download/3b0e82ec-0eb4-4bac-9fc2-6c1912b31d3e
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
