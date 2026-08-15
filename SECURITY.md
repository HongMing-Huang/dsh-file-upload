# Security Policy

## Reporting a Vulnerability

Please do **not** open a public issue for security vulnerabilities.

Report privately by opening a [security advisory](https://github.com/HongMing-Huang/dsh-file-upload/security/advisories/new)
on this repository, or email the maintainer through the GitHub contact link on
the profile page. You should receive a response within 72 hours.

## Scope

- The plugin's upload handler (loopback enforcement, file name sanitization,
  session isolation, concurrency limits).
- Document conversion paths (PDF/DOCX/XLSX parsers, MarkItDown CLI
  invocation).
- Any injection or path-traversal vectors through uploaded file names or
  session ids.

## Out of scope

- Third-party dependencies (report to their own projects).
- The DeepSeek Harness core itself (report to
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)).
