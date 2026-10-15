/**
 * The type floor (DESIGN.md Hierarchy, "Floor"): nothing the operator reads is under 13px on a desk or 14px under 720px,
 * except uppercase labels (at least 11px) and text inside a zoomable canvas (the run stage's graph cards and chips, the
 * skills graph's SVG labels), whose on-screen size follows the zoom. Every size at the floor is the one `--type-floor`
 * property, defined on `:root` as 13px and as 14px inside the single `max-width: 719px` rule of src/index.css; a size
 * between 13px and 14px elsewhere is written `max(<size>, var(--type-floor))`, so no literal can sit under the phone floor.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FLOOR = { desktop: 13, phone: 14 }
const LABEL_FLOOR = 11
const PROPERTY = '--type-floor'

/** Selectors whose text lives in a zoomable canvas ([G6]): the run stage's cards and chips and the skills graph's SVG labels. */
const EXEMPT_SELECTORS = [/\.n-(chip|meta|word|last)\b/, /\.node\s+\.label\b/, /\.unavailable-tag\b/, /\.empty-tag\b/]

interface Rule { file: string; selector: string; body: string; media: string[]; start: number }
interface Finding { file: string; selector: string; declaration: string; reason: string }

function cssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return path.endsWith('.css') ? [path] : []
  })
}

/** A small block parser: rules with their enclosing at-rule preludes; keyframes and font-face bodies are skipped. */
export function parseRules(file: string, css: string): Rule[] {
  // Comments become blanks of the same length, so offsets still point into the file.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
  const rules: Rule[] = []
  const stack: { prelude: string; at: boolean; start: number }[] = []
  let buffer = ''
  let body = ''
  let depth = 0
  for (let offset = 0; offset < text.length; offset += 1) {
    const char = text[offset]
    if (char === '{') {
      stack.push({ prelude: buffer.trim(), at: buffer.trim().startsWith('@'), start: offset + 1 })
      buffer = ''
      body = ''
      depth += 1
    } else if (char === '}') {
      const closing = stack.pop()
      depth -= 1
      const declarations = (body + buffer).trim()
      if (closing && !closing.at && declarations !== '') {
        const media = stack.filter(entry => entry.at).map(entry => entry.prelude)
        if (!media.some(entry => /^@(keyframes|font-face)/.test(entry))) rules.push({ file, selector: closing.prelude, body: declarations, media, start: closing.start })
      }
      buffer = ''
      body = ''
    } else if (char === ';' && stack.length > 0 && !stack[stack.length - 1].at) {
      body += `${buffer};`
      buffer = ''
    } else {
      buffer += char
    }
  }
  assert.equal(depth, 0, `${file}: unbalanced braces`)
  return rules
}

interface Size { desktop: number; phone: number; relative: boolean }

/** Resolves a font-size value; `null` for a value the test cannot size (inherit, keywords). */
export function sizeOf(value: string): Size | null {
  const text = value.trim()
  const property = new RegExp(`^var\\(${PROPERTY}\\)$`)
  if (property.test(text)) return { desktop: FLOOR.desktop, phone: FLOOR.phone, relative: false }
  const max = /^max\((.*)\)$/.exec(text)
  if (max) {
    const parts = splitTop(max[1]).map(sizeOf)
    if (parts.some(part => part === null)) return null
    const sizes = parts as Size[]
    return { desktop: Math.max(...sizes.map(size => size.desktop)), phone: Math.max(...sizes.map(size => size.phone)), relative: sizes.every(size => size.relative) }
  }
  const calc = /^calc\(\s*(\d*\.?\d+)px\s*\*/.exec(text)
  if (calc) return { desktop: Number(calc[1]), phone: Number(calc[1]), relative: false }
  const length = /^(\d*\.?\d+)(px|rem|em|%)$/.exec(text)
  if (!length) return null
  const amount = Number(length[1])
  if (length[2] === 'px') return { desktop: amount, phone: amount, relative: false }
  if (length[2] === 'rem') return { desktop: amount * 16, phone: amount * 16, relative: false }
  const relative = length[2] === '%' ? amount / 100 : amount
  return { desktop: relative, phone: relative, relative: true }
}

function splitTop(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = '' } else current += char
  }
  parts.push(current)
  return parts
}

/** The size token a declaration sets: `font-size: <v>` or the size inside a `font` shorthand. */
function sizeDeclarations(body: string): { declaration: string; value: string }[] {
  const found: { declaration: string; value: string }[] = []
  for (const part of body.split(';')) {
    const declaration = part.trim()
    const size = /^font-size\s*:\s*(.+)$/s.exec(declaration)
    if (size) { found.push({ declaration, value: size[1].replace(/!important/, '') }); continue }
    const shorthand = /^font\s*:\s*(.+)$/s.exec(declaration)
    if (shorthand) {
      const token = shorthand[1].split(/\s+/).map(word => word.split('/')[0]).find(word => /^\d*\.?\d+(px|rem|em|%)$/.test(word) || /^(max|calc)\(/.test(word))
      if (token) found.push({ declaration, value: token })
    }
  }
  return found
}

export function checkRules(rules: Rule[]): Finding[] {
  const findings: Finding[] = []
  for (const rule of rules) {
    const uppercase = /text-transform\s*:\s*uppercase/.test(rule.body)
    const exempt = rule.selector.split(',').every(selector => EXEMPT_SELECTORS.some(pattern => pattern.test(selector)))
    const phoneOnly = rule.media.some(entry => /max-width:\s*719px/.test(entry))
    const code = rule.selector.split(',').some(selector => /\bcode\b/.test(selector))
    for (const { declaration, value } of sizeDeclarations(rule.body)) {
      const size = sizeOf(value)
      const report = (reason: string) => findings.push({ file: rule.file, selector: rule.selector, declaration, reason })
      if (size === null || exempt) continue
      if (size.relative) {
        if (size.desktop < 1 && (code || !uppercase)) report(`a relative size below 1 (${size.desktop})`)
        continue
      }
      if (uppercase) {
        if (size.desktop < LABEL_FLOOR || size.phone < LABEL_FLOOR) report(`an uppercase label under ${LABEL_FLOOR}px`)
        continue
      }
      if (!phoneOnly && size.desktop < FLOOR.desktop) report(`under ${FLOOR.desktop}px`)
      else if (size.phone < FLOOR.phone) report(`under ${FLOOR.phone}px on a phone (write max(<size>, var(${PROPERTY})))`)
    }
  }
  return findings
}

const rulesOf = (css: string) => parseRules('test.css', css)

describe('the type floor', () => {
  test('every stylesheet under src keeps the floor', () => {
    const findings = cssFiles('src').flatMap(file => checkRules(parseRules(file, readFileSync(file, 'utf8'))))
    assert.deepEqual(findings.map(finding => `${finding.file} ${finding.selector} { ${finding.declaration} } ${finding.reason}`), [])
  })

  test('the floor property is 13px on :root and 14px in the one phone rule', () => {
    const rules = parseRules('src/index.css', readFileSync('src/index.css', 'utf8'))
    const definitions = rules.filter(rule => rule.body.includes(`${PROPERTY}:`))
    assert.equal(definitions.length, 2)
    const desktop = definitions.find(rule => rule.media.length === 0)
    const phone = definitions.find(rule => rule.media.some(entry => /^@media\s*\(max-width:\s*719px\)$/.test(entry)))
    assert.equal(desktop?.selector, ':root')
    assert.match(desktop?.body ?? '', new RegExp(`${PROPERTY}:\\s*13px`))
    assert.equal(phone?.selector, ':root')
    assert.match(phone?.body ?? '', new RegExp(`${PROPERTY}:\\s*14px`))
  })

  test('a hand-inserted 13px, 0.85rem, shorthand or small size is rejected', () => {
    assert.equal(checkRules(rulesOf('.a { font-size: 13px; }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font-size: 0.85rem; }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font-size: 13.5px; }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font-size: 12.5px; }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font: 600 13px/1.4 var(--font-mono); }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font: 12px var(--font-mono); }')).length, 1)
    assert.equal(checkRules(rulesOf('@media (max-width: 719px) { .a { font-size: 13.5px; } }')).length, 1)
  })

  test('the floor property, max() of it and anything from 14px up pass', () => {
    assert.deepEqual(checkRules(rulesOf('.a { font-size: var(--type-floor); }')), [])
    assert.deepEqual(checkRules(rulesOf('.a { font-size: max(0.85rem, var(--type-floor)); }')), [])
    assert.deepEqual(checkRules(rulesOf('.a { font: 600 var(--type-floor)/1.4 var(--font-mono); }')), [])
    assert.deepEqual(checkRules(rulesOf('.a { font-size: 14px; } .b { font-size: 0.9rem; } .c { font-size: 1.25rem; }')), [])
  })

  test('only an uppercase rule goes down to 11px, and never below', () => {
    assert.deepEqual(checkRules(rulesOf('.a { font-size: 11px; text-transform: uppercase; }')), [])
    assert.deepEqual(checkRules(rulesOf('.a { font-size: 11.5px; letter-spacing: 0.1em; text-transform: uppercase; }')), [])
    assert.equal(checkRules(rulesOf('.a { font-size: 10px; text-transform: uppercase; }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font-size: 11px; }')).length, 1)
    assert.equal(checkRules(rulesOf('.a { font-size: 11px; } .a { text-transform: uppercase; }')).length, 1)
  })

  test('the zoomable canvas selectors are the only other exemption', () => {
    assert.deepEqual(checkRules(rulesOf('.sb-stage .n-chip { font-size: 10px; } .n-meta, .n-word { font-size: 11px; } .node .label { font-size: 12px; } .unavailable-tag, .empty-tag { font-size: calc(10px * var(--inv)); }')), [])
    assert.equal(checkRules(rulesOf('.sb-stage .n-chips { font-size: 10px; }')).length, 1)
    assert.equal(checkRules(rulesOf('.sb-stage .n-chip, .sb-stage .other { font-size: 10px; }')).length, 1)
    assert.equal(checkRules(rulesOf('.node .labelled { font-size: 10px; }')).length, 1)
  })

  test('code is never smaller than the text around it', () => {
    assert.equal(checkRules(rulesOf('.a code { font-size: 0.85em; }')).length, 1)
    assert.deepEqual(checkRules(rulesOf('.a code { font-size: 1em; }')), [])
    assert.equal(checkRules(rulesOf('.a code, .b { font-size: 0.9em; }')).length, 1)
  })

  test('calc(<n>px * …) reads as <n>px', () => {
    assert.equal(checkRules(rulesOf('.a { font-size: calc(12px * var(--k)); }')).length, 1)
    assert.deepEqual(checkRules(rulesOf('.a { font-size: calc(14px * var(--k)); }')), [])
  })
})
