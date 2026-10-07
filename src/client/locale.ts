/**
 * Locale copy for the browser half: one namespace, two complete dictionaries.
 *
 * The harness locale registry (`@deepseek-ai/dsh-client-locale`, carried by the
 * web bundle) owns the active locale; this module owns only the strings. The
 * `en` annotation makes a missing or extra key against `zh` a compile error, so
 * the dictionaries cannot drift apart without the build saying so.
 */

/** Locale namespace owned by this plugin. */
export const NS = 'dsh-file-upload'

/** Namespace-bound translator; the same shape the harness `Translate` type carries. */
export type Translator = (key: string, params?: Record<string, unknown>) => string

/** Simplified Chinese dictionary — the key set every locale has to cover. */
export const zh = {
  'http.413': '文件超过大小限制',
  'http.415': '文件类型不被允许',
  'http.403': '会话校验失败，请刷新页面重试',
  'http.429': '上传太频繁，请稍后再试',
  'upload.busy': '上传中…',
  'upload.failed': '上传失败',
  'upload.networkError': '{name}: 网络错误，上传失败',
  'upload.label': '上传文件',
  'drag.title': '松开以添加文件',
  'drag.desc': '文件/文件夹将上传到当前会话,agent 可读取其内容',
  'card.cancel': '取消上传',
  'card.remove': '移除',
  'card.close': '关闭',
  'image.description': '[图片: {name}] 图片讲解:\n{description}'
} satisfies Record<string, string>

/** English dictionary; the annotation turns a missing or extra key into a compile error. */
export const en: Record<keyof typeof zh, string> = {
  'http.413': 'File exceeds the size limit',
  'http.415': 'File type not allowed',
  'http.403': 'Session validation failed; refresh the page and try again',
  'http.429': 'Uploading too frequently; try again later',
  'upload.busy': 'Uploading…',
  'upload.failed': 'Upload failed',
  'upload.networkError': '{name}: network error, upload failed',
  'upload.label': 'Upload file',
  'drag.title': 'Release to add files',
  'drag.desc': 'Files and folders upload to the current session; the agent can read their contents',
  'card.cancel': 'Cancel upload',
  'card.remove': 'Remove',
  'card.close': 'Close',
  'image.description': '[image: {name}] image description:\n{description}'
}