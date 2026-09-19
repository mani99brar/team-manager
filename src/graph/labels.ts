/** Wraps a name into short lines, preferring to break after separators. Full names stay in aria-labels. */
export function wrapLabel(name: string, maxChars = 14, maxLines = 3): string[] {
  const lines: string[] = []
  let rest = name
  while (rest.length > 0 && lines.length < maxLines) {
    if (rest.length <= maxChars) { lines.push(rest); rest = ''; break }
    let cut = -1
    for (let i = maxChars; i > 3; i -= 1) {
      if ('-_. '.includes(rest[i - 1])) { cut = i; break }
    }
    if (cut === -1) cut = maxChars
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, maxChars - 1)}…`
  return lines
}
