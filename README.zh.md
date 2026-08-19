# dsh-file-upload

**DeepSeek Harness (dsh) 文件消息插件。** Claude 桌面端风格的拖拽/回形针文件上传,内容嗅探,文档转 Markdown 全部内置打包(MarkItDown 引擎,20+ 格式,图片 OCR),小文本直插输入框,语音输入,以及供 agent 使用的 `read_document` 工具。

[![npm](https://img.shields.io/npm/v/dsh-file-upload)](https://www.npmjs.com/package/dsh-file-upload)
[![CI](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml/badge.svg)](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

> **零配置,安装即用。** 所有功能开箱即用,带合理默认——不需要 Python、不需要下载、不需要挑选后端。唯一可选的是音频文件转写的 ASR 密钥,而它也会从标准的 `OPENAI_API_KEY` 凭据自动检测。

## 功能

- **上传**:composer 回形针按钮 + 全局拖拽(拖动文件到窗口任意位置 → "松开以添加文件"遮罩 → 松开即上传),多文件支持。
- **附件卡片**:按类型着色的徽标卡(PDF 红 / DOC 蓝 / XLS 绿 / TXT 灰 / ZIP 紫 / JSON 金),显示名称与大小,可移除。
- **Codex 风格文件引用**:上传的文件在消息中呈现为 `@相对路径` 引用(与 OpenAI Codex 一致),**不会把全文塞进输入框**;agent 用 `read_document` 读取(按需转 Markdown)。
- **Codex 风格 `@` 引用**:上传后在输入框输入 `@` 即可按相对路径选择已上传文件,以 mention 形式插入。
- **文档转 Markdown(全部内置打包)**:MarkItDown 引擎随插件发布(微软 MarkItDown 的 TypeScript 移植 `markitdown-node`):PDF / DOCX / PPTX / XLSX / HTML / CSV / JSON / XML / RSS / Atom / ZIP / Jupyter / 图片 OCR / 音频转写。**无需 Python、无需下载、无需配置。**
- **图片自动讲解(文本模型也能看懂)**:上传图片后自动通过**视觉发现链**生成图片描述("讲解图片"),纯文本的 DeepSeek API 也能基于图片内容推理:显式 `visionEndpoint` → 本地 Ollama(如 DeepSeek-VL2,零配置)→ OpenAI 兼容端点(DSH 凭据 key)。多模态模型/视觉桥接则走官方 `read_image`。
- **`read_document` 工具(供 agent 使用)**:行号分页(`offset`/`limit`)、字节预算 LRU 缓存(文件改动自动失效)、大小预检、走 `ctx.fs`(继承沙箱与 fs 观察策略)。
- **安全**:loopback-only 上传、文件名消毒、会话隔离存储(`.dsh-uploads/<sessionId>`)、sha256 内容去重、并发限流、TTL 清扫。

## 安装

```sh
dsh plugin --profile web add dsh-file-upload
# 重启 dsh web
```

## 使用

1. 点 composer 工具栏的回形针按钮,或把文件拖到窗口任意位置;
2. 小文本文件内容直接进入输入框;文档显示为附件卡,路径随消息发出;
3. agent 用 `read_document <路径>` 读取文档——按需转 Markdown,支持 `offset`/`limit` 翻页。

### MarkItDown(全部内置打包,零下载零安装)

**MarkItDown 能力已完整打包进插件,装完即用:不需要 Python、不需要 pip、不需要下载、不需要构建脚本授权。**

- **内置引擎**:微软 MarkItDown 的 TypeScript 移植(`markitdown-node`)作为正式依赖随包发布,覆盖 **20+ 格式**——PDF / DOCX / PPTX / XLSX / HTML / CSV / JSON / XML / RSS / Atom / ZIP / Jupyter / 图片 OCR(Tesseract,110+ 语言)/ 音频转写(经 LLM,需模型凭据)。
- **图片**:默认经内置引擎 OCR 转文字,无需视觉插件。
- **离线可用**:所有解析在本地完成,无网络依赖。

> 可选增强:如果机器上本来就装有官方 MarkItDown CLI(或通过 `markitdownBin` 指定),插件会自动优先使用它(额外支持 EPUB 等);没有也完全不影响——内置引擎始终可用。

```yaml
- id: file-upload
  config:
    markitdownBin: /path/to/your/markitdown   # 可选;留空 = 纯内置引擎
```

内置模式启动日志:

```
[dsh-file-upload] Document → Markdown ready: bundled MarkItDown engine (20+ formats, image OCR) — fully packaged, no downloads, no Python.
```

### 图片怎么处理(自动讲解)

插件在**上传时自动检测当前会话模型的图像能力**:

| 检测到的路由 | 行为 |
|---|---|
| **多模态模型**(声明 `image` 输入,如 GPT-4o / Qwen-VL / Claude / Gemini) | `imageMode: native`——agent 用官方 `read_image` 工具,图片直接进入模型上下文 |
| **已装视觉桥接**(如 [dsh-vision-proxy](https://github.com/Flyvhidbwo/dsh-vision-proxy)) | 自动识别——同样走 native 路径 |
| **纯文本模型**(DeepSeek API 即纯文本) | **自动生成图片描述**,随消息发出——模型立即基于图片内容推理 |

**视觉发现链(零配置)**:① 显式 `visionEndpoint`/`visionModel` → ② **本地 Ollama**(`http://localhost:11434`,自动选择 VL 模型如 DeepSeek-VL2,图片不出本机)→ ③ OpenAI 标准端点(DSH 凭据 key)。

> 说明:DeepSeek 官方 API 目前**不提供视觉输入**(多模态线 DeepSeek-VL2/Janus 为开源可自托管);通过 Ollama 本地部署 DeepSeek-VL2,即可获得完全本地的"官方 DeepSeek 视觉"体验。

路由检测与官方 `read_image` 门控一致(`ctx.llm.resolveModelInfo` + `inputModalities`)。

## 配置

> 所有字段都有合理默认——安装后直接使用,无需修改任何配置。按需调整即可。

| 字段 | 默认 | 说明 |
|---|---|---|
| `uploadMaxBytes` | 25165824 (24MB) | 单文件上传上限 |
| `allowedExtensions` | `[]` | 扩展名白名单;空 = 全部允许 |
| `uploadTtlMs` | 604800000 (7天) | 未引用上传文件保留时长 |
| `sweepIntervalMs` | 3600000 (1h) | 清扫周期;0 = 关闭 |
| `maxConcurrentUploads` | 4 | 并发上传上限 |
| `inlineTextLimit` | 8192 (8KB) | 直插输入框的文本大小上限 |
| `previewTextLimit` | 2048 (2KB) | 大文本预览长度 |
| `maxFileBytes` | 25165824 | 单次文档读取字节上限 |
| `readLimit` | 2000 | `read_document` 单次返回行数上限 |
| `sheetRowLimit` | 200 | 每个 XLSX sheet 保留行数 |
| `maxSheets` | 5 | 读取的 sheet 数 |
| `cacheEntries` | 16 | 解析缓存条目数 |
| `cacheMaxBytes` | 67108864 (64MB) | 解析缓存字节预算 |
| `markitdownBin` | `''` | 可选 MarkItDown CLI 路径;空 = 自动探测 PATH |
| `markitdownTimeoutMs` | 120000 | 单次 CLI 调用超时 |
| `visionEndpoint` | `''` | 图片讲解的视觉端点;空 = 自动(本地 Ollama → OpenAI 标准) |
| `visionModel` | `''` | 视觉模型名;空 = 自动 |
| `visionApiKeyEnv` | `OPENAI_API_KEY` | 视觉 key 的凭据引用(DSH 凭据体系) |
| `visionMaxBytes` | 10485760 (10MB) | 发送给视觉端点的图片大小上限 |

## 开发

```sh
pnpm install
pnpm build     # tsc(host)+ esbuild(client bundle)
pnpm test      # node --test
```

## 架构

```
src/
├── index.ts        # 入口:apply + Config schema + 组装
├── detect.ts       # 内容嗅探(不信任扩展名)
├── convert.ts      # MarkItDown 引擎 + 可选 CLI 后端
├── vision.ts       # 图片讲解(视觉发现链)
├── upload.ts       # 上传路由:loopback/会话/大小/去重/TTL
├── tool.ts         # read_document:ctx.fs 读取 + 分页 + LRU 缓存
└── client/
    └── index.tsx   # 回形针 + 拖拽遮罩 + 麦克风 + 附件卡片
```

双面插件:`dsh.bundle`(host)+ `dsh.client`(web UI)。无任何官方补丁,全部走官方 seam(`ctx.webServer` / `ctx.tools` / `ctx.systemPrompt` / `ctx.sessions` / `slash/input-insert-text` / `slash/input-insert-reference`)。

## 安全

- 上传仅限 loopback,并做同源校验。
- 文件名消毒(控制字符、路径分隔符、点段、前导点全部剥离)。
- 存储按会话隔离在工作区下;未知会话返回 403。
- sha256 内容去重、并发限流(超限 429)、TTL 清扫。
- 文本提取按字节嗅探,不信任扩展名;二进制文件只以路径形式交给 agent。

## License

MIT
