/** Client-side name checks mirroring the server's shared validator; the server remains authoritative. */
export function validateName(name: string, kind: 'file' | 'folder'): string | null {
  if (name.length === 0) return 'Enter a name.'
  if (name.includes('/') || name.includes('\\')) return 'The name cannot contain / or \\ (create nested folders one at a time).'
  if (name.includes('\0')) return 'The name contains an invalid character.'
  if (name === '.' || name === '..') return 'That name is reserved.'
  const markdown = name.toLowerCase().endsWith('.md')
  if (kind === 'file' && !markdown) return 'The file name must end in .md.'
  if (kind === 'folder' && markdown) return 'A folder name cannot end in .md.'
  return null
}
