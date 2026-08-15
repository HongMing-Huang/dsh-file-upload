# dsh-file-upload

**DeepSeek Harness (dsh) 文件消息插件** —— Claude 桌面端风格的拖拽/回形针文件上传,内容嗅探、文档转 Markdown(内置 JS 解析 + 可选微软 MarkItDown CLI),小文本直插输入框,`read_document` 工具让 agent 分页读取。

[![npm](https://img.shields.io/npm/v/dsh-file-upload)](https://www.npmjs.com/package/dsh-file-upload)
[![CI](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml/badge.svg)](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

## 能力

- **上传**:composer 回形针按钮 + 全局拖拽(拖动文件到窗口任意位置 → "松开以添加文件"遮罩 → 松开即上传),多文件支持
- **附件卡片**:按类型着色的徽标卡(PDF 红 / DOC 蓝 / XLS 绿 / TXT 灰 / ZIP 紫 / JSON 金),显示名称、大小,可移除
- **文本直插(Claude 风格)**:小的文本文件(代码/JSON/CSV/日志/配置…)上传后**内容直接进输入框**,模型第一眼就看到文件内容;大文本插入路径引用
- **文档转 Markdown(全部内置打包)**:MarkItDown 引擎随插件发布,覆盖 PDF/DOCX/PPTX/XLSX/HTML/CSV/JSON/XML/ZIP/Jupyter/图片 OCR 等 20+ 格式,**装完即用,零下载零 Python**;
- **MarkItDown 全部内置打包**:微软 MarkItDown 引擎(TS 移植)随插件发布,20+ 格式 + 图片 OCR,零下载零 Python;机器上已有官方 CLI 时自动优先
- **`read_document` 工具**:行号分页、`offset`/`limit` 翻页、字节预算 LRU 缓存(文件改动自动失效)、大小预检、走 `ctx.fs`(继承沙箱与 fs 观察策略)
- **安全**:loopback-only、文件名消毒、会话隔离存储(`.dsh-uploads/<sessionId>`)、sha256 去重、并发限流、TTL 清扫

## 安装

```sh
dsh plugin --profile web add dsh-file-upload
# 重启 dsh web
```

## 使用

1. 点 composer 左侧回形针按钮,或直接拖文件到窗口;
2. 小文本文件内容自动进入输入框;文档显示为附件卡,路径随消息发出;
3. agent 对文档调用 `read_document <路径>` 读取全文(自动转 Markdown,可翻页)。

### MarkItDown(全部内置打包,零下载零安装)

**MarkItDown 能力已完整打包进插件,装完即用:不需要 Python、不需要 pip、不需要下载、不需要授权。**

- **内置引擎**:微软 MarkItDown 的 TypeScript 移植(`markitdown-node`)作为正式依赖随包发布,覆盖 **20+ 格式**——PDF / DOCX / PPTX / XLSX / HTML / CSV / JSON / XML / RSS / Atom / ZIP / Jupyter / 图片 OCR(Tesseract,110+ 语言)等;
- **音频转写**:内置引擎支持音频转文字(经 LLM,需配置模型凭据);
- **图片**:默认经内置引擎 OCR 转文字描述,无需任何视觉插件;
- **离线可用**:所有解析在本地完成,无网络依赖。

> 可选增强:如果你机器上本来就装有官方 MarkItDown CLI(或配置 `markitdownBin`),插件会自动优先使用它(支持 EPUB 等);没有也完全不影响——内置引擎始终兜底。

```yaml
- id: file-upload
  config:
    markitdownBin: /path/to/your/markitdown   # 可选:已有 CLI 时指向它;留空 = 纯内置
```

启动日志:内置引擎就绪时显示 `[dsh-file-upload] Document → Markdown ready: bundled MarkItDown engine (20+ formats, image OCR) — fully packaged, no downloads, no Python.`

### 图片怎么处理

| 场景 | 路径 |
|---|---|
| 模型支持图像输入(或已装视觉桥接插件如 dsh-vision-router) | agent 用官方 `read_image` 工具读取上传图片 |
| 默认(无视觉路由) | `read_document <图片路径>` → 内置引擎 OCR(Tesseract,110+ 语言)返回文字描述 |
| MarkItDown CLI + LLM 凭据 | `read_document <图片路径>` → 官方 CLI 描述图片 |

systemPrompt 已注入上述指引,agent 会自动选择合适路径。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `uploadMaxBytes` | 25165824 (24MB) | 单文件上传上限 |
| `allowedExtensions` | `[]` | 扩展名白名单;空 = 全部允许 |
| `uploadTtlMs` | 604800000 (7天) | 未清理文件保留时长 |
| `sweepIntervalMs` | 3600000 (1h) | 清扫周期;0 = 关闭 |
| `maxConcurrentUploads` | 4 | 并发上传上限 |
| `inlineTextLimit` | 8192 (8KB) | 文本直插输入框的字节上限 |
| `previewTextLimit` | 2048 (2KB) | 大文本预览长度 |
| `maxFileBytes` | 25165824 | 单次文档读取字节上限 |
| `readLimit` | 2000 | read_document 单次返回行数上限 |
| `sheetRowLimit` | 200 | 每个 XLSX sheet 保留行数 |
| `maxSheets` | 5 | 读取的 sheet 数 |
| `cacheEntries` | 16 | 解析缓存条目数 |
| `cacheMaxBytes` | 67108864 (64MB) | 解析缓存字节预算 |
| `markitdownBin` | `''` | MarkItDown CLI 路径;空 = 自动探测 PATH |
| `markitdownTimeoutMs` | 120000 | 单次 MarkItDown 调用超时 |

## 开发

```sh
pnpm install
pnpm build     # tsc + esbuild(host lib/ + client lib/client.js)
pnpm test      # node --test
```

## 架构

```
src/
├── index.ts        # 入口 apply + Config schema + 组装
├── detect.ts       # 内容嗅探(不信任扩展名):text/pdf/docx/xlsx/image/archive/binary
├── convert.ts      # 转换链:JS 内置(文本/PDF/DOCX/XLSX)+ 可选 MarkItDown CLI
├── upload.ts       # 上传路由:loopback 校验/会话隔离/sha256 去重/限流/TTL
├── tool.ts         # read_document:ctx.fs 解析 + 分页 + LRU 缓存
└── client/
    └── index.tsx   # 回形针按钮 + 拖拽遮罩 + 附件卡片(client face)
```

双面插件:`dsh.bundle`(host)+ `dsh.client`(web UI),无任何官方补丁,全部走官方 seam(`ctx.webServer` / `ctx.tools` / `ctx.systemPrompt` / `ctx.sessions` / `slash/input-insert-text` / `slash/input-insert-reference`)。

## License

MIT
