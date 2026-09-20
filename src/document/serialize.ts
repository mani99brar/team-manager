import { Text } from '@codemirror/state'

const BOM = '﻿'

/**
 * CodeMirror keeps lines, not line-ending bytes. A file is editable only when every line break is the same
 * (all LF or all CRLF) so the original ending can be restored on serialization. A leading BOM is held aside
 * and restored. Anything else (lone CR, mixed endings) cannot be round-tripped losslessly and stays read-only.
 */
export type TextAnalysis =
  | { editable: true; bom: boolean; lineEnding: '\n' | '\r\n' }
  | { editable: false; bom: boolean; lineEnding: '\n' | '\r\n'; reason: string }

export function analyzeText(content: string): TextAnalysis {
  const bom = content.startsWith(BOM)
  const body = bom ? content.slice(1) : content
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < body.length; i += 1) {
    const char = body.charCodeAt(i)
    if (char === 13) {
      if (body.charCodeAt(i + 1) === 10) { crlf += 1; i += 1 } else cr += 1
    } else if (char === 10) lf += 1
  }
  if (cr > 0) return { editable: false, bom, lineEnding: '\n', reason: 'it contains bare carriage-return line endings' }
  if (crlf > 0 && lf > 0) return { editable: false, bom, lineEnding: '\n', reason: 'it has mixed line endings (both CRLF and LF)' }
  return { editable: true, bom, lineEnding: crlf > 0 ? '\r\n' : '\n' }
}

export function textFromContent(content: string, analysis: TextAnalysis): Text {
  const body = analysis.bom ? content.slice(1) : content
  return Text.of(body.split(analysis.lineEnding))
}

export function serializeText(text: Text, analysis: TextAnalysis): string {
  return (analysis.bom ? BOM : '') + text.sliceString(0, text.length, analysis.lineEnding)
}

/** The SHA-256 the server would compute for this content encoded as UTF-8, as lowercase hex. */
export async function contentHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
