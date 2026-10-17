/**
 * The one redaction used wherever md-manager sends free text to a viewer or to GitHub (docs/PRD_RUN_SESSIONS.md 4,
 * docs/PRD_RUN_TEAMS.md 4.3): the server's API payloads (`server/projects.ts` re-exports these), the draft pull request body
 * the GitHub actions offer, and the viewer's Copy run summary. No imports, so the server and the viewer share one copy.
 */

/**
 * Absolute filesystem paths in persisted messages are never forwarded to clients. A path starts at the string start
 * or after any character that cannot be part of a path (so Markdown punctuation such as `[`, `|`, `<`, `*` and `(`
 * counts), or as the target of a `file://` URI, which is redacted together with its scheme. A segment holds any Unicode
 * letter, mark or digit, so a directory named `données` or `用户` is a path segment like an ASCII one. Only a letter of a
 * script written with spaces (Latin, Greek, Cyrillic) or a digit before the slash makes it a relative path: CJK, Thai and
 * other scripts put no space before a path, so `无法读取/home/u` is redacted (a relative path in them may be over-redacted).
 * One segment is enough: a root-level `/secret` or `/srv` is a path too, so a slash command or route name such as
 * `/sessions` is redacted as well (the safe direction); `P0/P1` and `and/or` stay, since a letter precedes their slash.
 */
export function redactPaths(text: string): string {
  return text.replace(/(?:file:\/\/(?=\/)|(?<![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}._@~+/-]))(?:~(?:\/[\p{L}\p{M}\p{N}._@~+-]*)+|\/[\p{L}\p{M}\p{N}._@~+-]+(?:\/[\p{L}\p{M}\p{N}._@~+-]*)*)/gu, '<path>')
}

/**
 * Credential-shaped strings are never forwarded (docs/PRD_RUN_SESSIONS.md 4, [P6], [L1]): a GitHub token (`ghp_`, the
 * `gho_`/`ghs_`/`ghu_`/`ghr_` OAuth, server and refresh tokens `gh auth token` prints, `github_pat_`), an OpenAI-style `sk-`
 * key, a Slack `xox?-` token, a `Bearer` header (any case), a `token=`/`password=`/`passwd=`/`secret=`/`api_key=`/`apikey=`/
 * `access_key=` assignment (any case, so `Password=` and `API_KEY=` too) or a PEM block (`-----BEGIN …-----` to its
 * `-----END …-----`, or to the text's end when cut) becomes `<redacted>`; an upper-case environment assignment of a
 * secret-looking name (`…TOKEN=`, `…SECRET…=`, `…KEY=`, `…PASSWORD=`, as in `TELEGRAM_BOT_TOKEN=…`) keeps its name and loses
 * its value (`NAME=<redacted>`); it runs first, so a bare upper-case `TOKEN=…` keeps its name as well. Each pattern is
 * anchored on a word boundary with a minimum tail, so ordinary words such as `task-file`, a lone `sk-`, `MONKEY`,
 * `TOKEN_COUNT=5`, `token count`, `Password policy:` or `bearer of news` stay intact.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN ([A-Z0-9 ]{1,64})-----[\s\S]*?(?:-----END \1-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  // A value already redacted by the environment assignment is left as it is (its name stays).
  /\b(?:token|api_?key|access_key)=(?!<redacted>)[A-Za-z0-9._~+/-]{12,}/gi,
  /\b(?:password|passwd|secret)=(?!<redacted>)\S{6,}/gi,
]
/** An upper-case environment assignment of a secret-looking name: the name is kept, the (quoted or bare) value is not. */
const SECRET_ASSIGNMENT = /\b((?:[A-Z][A-Z0-9_]*)?(?:SECRET[A-Z0-9_]*|TOKEN|KEY|PASSWORD|PASSWD))=(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g
export function redactCredentials(text: string): string {
  return CREDENTIAL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '<redacted>'), text.replace(SECRET_ASSIGNMENT, '$1=<redacted>'))
}

/** Every free text served under the sessions route: path-redacted, then credential-filtered (the resume command is exempt). */
export function redactText(text: string): string {
  return redactCredentials(redactPaths(text))
}
