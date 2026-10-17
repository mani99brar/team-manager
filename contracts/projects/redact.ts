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
 * Credential-shaped strings are never forwarded (docs/PRD_RUN_SESSIONS.md 4, [P6], [L1]), in three passes in this order:
 * 1. a PEM block (`-----BEGIN …-----` to its `-----END …-----`, or to the text's end when cut) becomes `<redacted>`, first, so no
 *    assignment pass can cut its BEGIN line off and leave the key body behind;
 * 2. token-shaped strings become `<redacted>`: a GitHub token (`ghp_`, the `gho_`/`ghs_`/`ghu_`/`ghr_` OAuth, server and refresh
 *    tokens `gh auth token` prints, `github_pat_`), an OpenAI-style `sk-` key, a Slack `xox?-` token, a `Bearer` header (any case);
 * 3. an assignment of a credential-like name keeps its name and loses its value (`name=<redacted>`): the name (any case) ends in
 *    a credential word (`token`, `secret`, `password`, `passwd`, `pwd`, `auth`, `api_key`/`apikey`, `access_key`, `private_key`,
 *    `client_secret`), optionally after prefix segments joined by `_`, `-` or `.` (`access_token`, `refresh_token`, `db_password`,
 *    `aws_secret_access_key`, `TELEGRAM_BOT_TOKEN`), may be quoted (`"password": …`), and is followed by optional spaces, `=` or
 *    `:`, optional spaces and a quoted value (single or double, redacted whole) or a bare value up to whitespace of at least six
 *    characters not counting a trailing `;`, `,`, `.`, `)` or `]` (left in place); an upper-case environment name ending in `TOKEN`, `KEY`, `PASSWORD` or holding `SECRET` (`STRIPE_KEY=`,
 *    `SECRET_KEY_BASE=`) loses its `=` value of any length.
 * Each pattern is anchored with a minimum tail, so ordinary words and prose such as `task-file`, a lone `sk-`, `MONKEY`,
 * `keyboard`, `TOKEN_COUNT=5`, `token count: 5`, `Password policy: strong`, `the secret is out` or `bearer of news` stay intact.
 */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]{1,64})-----[\s\S]*?(?:-----END \1-----|$)/g
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
]
/**
 * A credential-like name and its value: group 1 is the name with its separator (kept), the rest is the value. The last name
 * segment must end in a credential word (so `TOKEN_COUNT` or `token count` is no credential name), `pwd` and `auth` only as a
 * whole segment (so `author:` stays). A bare value already `<redacted>` by an earlier pass is left as it is.
 */
const CREDENTIAL_ASSIGNMENT = new RegExp(
  '(?<![A-Za-z0-9])('
  + '(?:[A-Za-z0-9]+[_.-])*'
  + '(?:[A-Za-z0-9]*(?:token|secret|password|passwd)|pwd|auth|(?:api|access|private)[_.-]?key|client[_.-]?secret)'
  + '["\']?[ \\t]*[=:][ \\t]*)'
  + '(?:"[^"\\n]*"|\'[^\'\\n]*\'|(?!<redacted>)[^\\s"\']{5,}[^\\s"\';,.)\\]])',
  'gi',
)
/** An upper-case environment assignment of a `…TOKEN`, `…KEY`, `…PASSWORD` or `…SECRET…` name: the name is kept, the (quoted or bare) value is not. */
const SECRET_ASSIGNMENT = /\b((?:[A-Z][A-Z0-9_]*)?(?:SECRET[A-Z0-9_]*|TOKEN|KEY|PASSWORD|PASSWD))=(?:"[^"\n]*"|'[^'\n]*'|(?!<redacted>)[^\s"']+)/g
export function redactCredentials(text: string): string {
  const tokensGone = TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '<redacted>'), text.replace(PEM_BLOCK, '<redacted>'))
  return tokensGone.replace(CREDENTIAL_ASSIGNMENT, '$1<redacted>').replace(SECRET_ASSIGNMENT, '$1=<redacted>')
}

/** Every free text served under the sessions route: path-redacted, then credential-filtered (the resume command is exempt). */
export function redactText(text: string): string {
  return redactCredentials(redactPaths(text))
}
