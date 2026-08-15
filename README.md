# dsh-file-upload

**DeepSeek Harness (dsh) 文件消息插件** —— Claude 桌面端风格的拖拽/回形针文件上传,内容嗅探、文档转 Markdown(内置 JS 解析 + 可选微软 MarkItDown CLI),小文本直插输入框,`read_document` 工具让 agent 分页读取。

[![npm](https://img.shields.io/npm/v/dsh-file-upload)](https://www.npmjs.com/package/dsh-file-upload)
[![CI](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml/badge.svg)](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

## 能力

- **上传**:composer 回形针按钮 + 全局拖拽(拖动文件到窗口任意位置 → "松开以添加文件"遮罩 → 松开即上传),多文件支持
- **附件卡片**:按类型着色的徽标卡(PDF 红 / DOC 蓝 / XLS 绿 / TXT 灰 / ZIP 紫 / JSON 金),显示名称、大小,可移除
- **文本直插(Claude 风格)**:小的文本文件(代码/JSON/CSV/日志/配置…)上传后**内容直接进输入框**,模型第一眼就看到文件内容;大文本插入路径引用
- **文档转 Markdown(开箱即用,非可选)**:内置 [markitdown-node](https://www.npmjs.com/package/markitdown-node) 引擎(微软 MarkItDown 的 TypeScript 移植),覆盖 PDF/DOCX/PPTX/XLSX/HTML/CSV/JSON/XML/ZIP/Jupyter/图片 OCR 等 20+ 格式,**装完即用,零外部依赖**;
- **MarkItDown CLI 增强(可选)**:检测到微软官方 [MarkItDown](https://github.com/microsoft/markitdown) CLI 时自动启用,进一步支持音频转写、EPUB 等;内置引擎始终兜底
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

### MarkItDown CLI(可选增强,非必需)

文档转 Markdown **默认可用**(内置引擎,零配置)。微软官方 CLI 提供额外格式(音频转写、EPUB 等),推荐安装(Python 3.10–3.13):

```sh
# Global install (core office formats)
pip install 'markitdown[docx,pdf,xlsx,pptx]'

# Or a virtualenv (recommended)
python3 -m venv ~/.venvs/markitdown
~/.venvs/markitdown/bin/pip install 'markitdown[docx,pdf,xlsx,pptx]'
```

> ⚠️ Avoid `markitdown[all]`: on newer Pythons (3.14+) some optional deps fail to resolve and pip falls back to the ancient 0.0.2. Use the extras list above for core formats; add `audio-transcription`/`youtube-transcription` and OCR (needs LLM credentials) on demand.

The plugin auto-detects the `markitdown` command (PATH or explicit `markitdownBin`):

```yaml
- insert:
    - id: file-upload
      name: 'dsh-file-upload'
      config:
        markitdownBin: ~/.venvs/markitdown/bin/markitdown   # explicit; empty = auto-detect on PATH
```

Startup logs show `[dsh-file-upload] MarkItDown CLI enabled: …` (or the install hint when missing).

### How images are handled

| Scenario | Path |
|---|---|
| Model accepts image input (or a vision bridge like dsh-vision-router is installed) | agent uses the official `read_image` tool |
| Default (no vision route) | `read_document <image path>` → bundled engine runs OCR (Tesseract, 110+ languages) and returns a text description |
| MarkItDown CLI with LLM credentials | `read_document <image path>` → official CLI describes the image |

The injected systemPrompt covers this guidance; the agent picks the right path automatically.

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
