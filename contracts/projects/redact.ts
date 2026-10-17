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
 * 3. an assignment of a credential-like name keeps its name and separator and loses its value (`name=<redacted>`). A small
 *    linear scanner (`redactAssignments`) finds each `=` or `:`, reads the identifier before it (`[A-Za-z0-9_.-]`, any length,
 *    optionally quoted) and decides in code, so no regex can backtrack over a long name:
 *    - a credential name ends (any case) in `token`, `secret`, `password`, `passwd`, `passphrase`, `apikey`/`api_key`,
 *      `access_key`, `private_key`, `secret_key` or `client_secret`, or has `pwd`/`auth` as its last whole segment
 *      (`access_token`, `db_password`, `aws_secret_access_key`, `client-secret`; never `TOKEN_COUNT`, `max_tokens` or `author`);
 *      an upper-case environment name ending in `KEY` or holding `SECRET` counts too (`STRIPE_KEY`, `SECRET_KEY_BASE`);
 *    - after `=` the value is redacted whatever its length, except a bare value under six characters (trailing `;,.)]` not
 *      counted) after a single-word name (`Token=short;`, `KEY = value` stay); after `:` only for a quoted (`"password": …`) or compound
 *      (`db_password:`) name, or a single word at the start of a line followed by one bare word of six characters or more
 *      (YAML `password: hunter22`), so prose such as `auth: refactored the middleware` or `see the password: section` stays;
 *    - the value is a quoted string up to its unescaped closing quote on the same line (to the line's end when unterminated),
 *      else the bare run up to whitespace, whatever it holds (quotes, `;`, `,`, a value that begins with `<redacted>`), so
 *      `token=123456;password="x"` or `password=\"x\"` leaves nothing behind.
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
const SECRET_WORDS = /(?:token|secret|password|passwd|passphrase|apikey|api[_.-]key|access[_.-]?key|private[_.-]?key|secret[_.-]?key|client[_.-]?secret)$/i
const WHOLE_SEGMENT_WORDS = /(?:^|[_.-])(?:pwd|auth)$/i
const IDENTIFIER = /[A-Za-z0-9_.-]/
/** A name longer than this is judged by its last characters (the credential word is at its end). */
const NAME_LOOKBACK = 512

/** Whether only spaces, tabs or a YAML list dash stand between the line's start and `index` (exclusive). */
function atLineStart(text: string, index: number): boolean {
  for (let at = index - 1, seen = 0; at >= 0 && seen < 64; at -= 1, seen += 1) {
    const char = text[at]
    if (char === '\n' || char === '\r') return true
    if (char !== ' ' && char !== '\t' && char !== '-') return false
  }
  return index - 1 < 64
}

function isCredentialName(name: string): boolean {
  const tail = name.slice(-64)
  if (SECRET_WORDS.test(tail) || WHOLE_SEGMENT_WORDS.test(tail)) return true
  return /^[A-Z0-9_]+$/.test(name) && (/KEY$/.test(name) || name.includes('SECRET'))
}

/** How far a quoted value may run across lines looking for its closing quote. */
const QUOTED_SPAN = 4096

/**
 * Where a quoted value ends: after its unescaped closing quote, even on a later line (a multi-line secret is one value), within
 * QUOTED_SPAN characters; without one, at the end of its first line (an unterminated quote still loses that line).
 */
function quotedEnd(text: string, start: number): number {
  const quote = text[start]
  let lineEnd = -1
  const limit = Math.min(text.length, start + QUOTED_SPAN)
  for (let at = start + 1; at < limit; at += 1) {
    const char = text[at]
    if (char === '\\') { at += 1; continue }
    if (char === quote) return at + 1
    if (lineEnd < 0 && (char === '\n' || char === '\r')) lineEnd = at
  }
  if (lineEnd >= 0) return lineEnd
  const newline = text.slice(start, start + QUOTED_SPAN * 4).search(/[\r\n]/)
  return newline < 0 ? text.length : start + newline
}

/** Where a bare value ends: at whitespace, leaving sentence punctuation that closes the run (`;`, `,`, `.`, `)`, `]`) in place. */
function bareEnd(text: string, start: number): number {
  let at = start
  while (at < text.length && !/\s/.test(text[at])) at += 1
  while (at > start + 1 && /[;,.)\]]/.test(text[at - 1])) at -= 1
  return at
}

/** Pass 3: each credential assignment keeps its name and separator; its value becomes `<redacted>` (see the docstring above). */
export function redactAssignments(text: string): string {
  const separators = /[=:]/g
  let out = ''
  let last = 0
  for (let match = separators.exec(text); match !== null; match = separators.exec(text)) {
    const at = match.index
    if (at < last) continue
    let end = at - 1
    while (end >= last && (text[end] === ' ' || text[end] === '\t')) end -= 1
    const closingQuote = end >= last && (text[end] === '"' || text[end] === "'") ? text[end] : null
    if (closingQuote !== null) end -= 1
    let start = end
    const floor = Math.max(last, end - NAME_LOOKBACK + 1)
    while (start >= floor && IDENTIFIER.test(text[start])) start -= 1
    const name = text.slice(start + 1, end + 1)
    if (name === '' || !isCredentialName(name)) continue
    const quotedName = closingQuote !== null && text[start] === closingQuote
    const nameStart = quotedName ? start : start + 1
    let valueStart = at + 1
    while (valueStart < text.length && (text[valueStart] === ' ' || text[valueStart] === '\t')) valueStart += 1
    if (valueStart >= text.length) continue
    if (text[valueStart] === '\n' || text[valueStart] === '\r') {
      // YAML puts a value on the next, indented line (`password:` then `  hunter22`): that line's one bare word is the value.
      if (match[0] !== ':' || !atLineStart(text, quotedName ? start : start + 1)) continue
      let next = valueStart
      while (next < text.length && /[\r\n]/.test(text[next])) next += 1
      const indent = next
      while (next < text.length && (text[next] === ' ' || text[next] === '\t')) next += 1
      if (next === indent) continue
      const wordEnd = bareEnd(text, next)
      const after = text[wordEnd]
      if (wordEnd - next < 6 || (after !== undefined && after !== '\n' && after !== '\r')) continue
      out += text.slice(last, next) + '<redacted>'
      last = wordEnd
      separators.lastIndex = wordEnd
      continue
    }
    const quotedValue = text[valueStart] === '"' || text[valueStart] === "'"
    const valueEnd = quotedValue ? quotedEnd(text, valueStart) : bareEnd(text, valueStart)
    const singleWord = !/[_.-]/.test(name)
    if (singleWord && !quotedValue && valueEnd - valueStart < 6) {
      // A single-word name (`Token`, `secret`, `KEY`) with a short bare value is prose more often than a secret: `Token=short;`.
      continue
    }
    if (match[0] === ':' && !quotedName && singleWord) {
      // A single bare word before `:` is prose unless it opens a line and one bare word of six characters or more ends it.
      const rest = text.slice(valueEnd, valueEnd + 2)
      const lineEnds = rest === '' || rest[0] === '\n' || rest[0] === '\r'
      if (quotedValue || !atLineStart(text, nameStart) || !lineEnds || valueEnd - valueStart < 6) continue
    }
    if (text.slice(valueStart, valueEnd) === '<redacted>') continue
    out += text.slice(last, valueStart) + '<redacted>'
    last = valueEnd
    separators.lastIndex = valueEnd
  }
  return out + text.slice(last)
}

export function redactCredentials(text: string): string {
  const tokensGone = TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '<redacted>'), text.replace(PEM_BLOCK, '<redacted>'))
  return redactAssignments(tokensGone)
}

/** Every free text served under the sessions route: path-redacted, then credential-filtered (the resume command is exempt). */
export function redactText(text: string): string {
  return redactCredentials(redactPaths(text))
}
