import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type IconName = 'grid' | 'file' | 'folder' | 'search' | 'agent' | 'workflow' | 'skill' | 'chevron' | 'arrow' | 'close' | 'copy' | 'check' | 'code'
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    agent: <><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2M16 12v2M9 17h6M1 11v5M23 11v5"/></>,
    workflow: <><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v9h9"/></>,
    skill: <path d="m13 2-9 12h7l-1 8 10-13h-7z"/>,
    chevron: <path d="m9 5 7 7-7 7"/>, arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>, check: <path d="m5 12 4 4L19 6"/>, code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

type Kind = 'Subagents' | 'Workflows' | 'Skills' | 'Other'
const kindIcons: Record<Kind, IconName> = { Subagents: 'agent', Workflows: 'workflow', Skills: 'skill', Other: 'file' }
const sources = import.meta.glob<string>(['/**/*.md', '!/node_modules/**', '!/.git/**', '!/dist/**'], { query: '?raw', import: 'default', eager: true })
const files = Object.entries(sources).map(([path, content]) => {
  path = path.replace(/^\//, '')
  const name = path.split('/').pop()!
  const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
  const kind: Kind = /(^|\/)subagents\//i.test(path) ? 'Subagents' : /(^|\/)skills\//i.test(path) ? 'Skills' : /workflow/i.test(path) ? 'Workflows' : 'Other'
  return { path, name, directory, kind, content, size: new TextEncoder().encode(content).length }
}).sort((a, b) => a.path.localeCompare(b.path))
type FileEntry = typeof files[number]
const directories = [...new Set(files.flatMap(f => f.directory === '.' ? [] : f.directory.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))))].sort()
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

function App() {
  const [category, setCategory] = useState('All files')
  const [directory, setDirectory] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('name')
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const lastFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!selected) return
    lastFocus.current = document.activeElement as HTMLElement
    closeRef.current?.focus()
    return () => lastFocus.current?.focus()
  }, [selected])
  const visible = files.filter(f => (category === 'All files' || f.kind === category) && (!directory || f.directory === directory || f.directory.startsWith(directory + '/')) && f.path.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === 'directory' ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  const reset = () => { setCategory('All files'); setDirectory(''); setQuery('') }
  const open = (file: FileEntry) => { setSelected(file); setRaw(false); setCopied(false); setCopyError(false) }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="./" aria-label="MD Manager home"><span className="brand-symbol">m<span>↓</span></span><span>md manager<span className="brand-dot">.</span></span></a>
        <div className="workspace"><span className="workspace-icon"><Icon name="folder" /></span><div><strong>md-manager-a</strong><span>Local repository</span></div><span className="status-dot" /></div>
        <div className="section-label">WORKSPACE</div>
        <nav aria-label="File categories">{['All files', 'Subagents', 'Workflows', 'Skills', 'Other'].map(item => <button key={item} className={`nav-item ${category === item ? 'active' : ''}`} onClick={() => { setCategory(item); setDirectory('') }}><Icon name={item === 'All files' ? 'grid' : kindIcons[item as Kind]} /><span>{item}</span><span className="nav-count">{item === 'All files' ? files.length : files.filter(f => f.kind === item).length}</span></button>)}</nav>
        <div className="section-label directory-label">DIRECTORIES <span>{directories.length}</span></div>
        <nav className="directories" aria-label="Directories"><button className={`tree-item ${directory === '' ? 'tree-active' : ''}`} onClick={() => setDirectory('')}><Icon name="folder" size={16} /><span>Repository root</span></button>{directories.map(path => <button key={path} title={path} className={`tree-item ${directory === path ? 'tree-active' : ''}`} style={{ paddingLeft: 14 + path.split('/').length * 15 }} onClick={() => setDirectory(path)}><Icon name="folder" size={16} /><span>{path.split('/').pop()}</span></button>)}</nav>
        <div className="sidebar-bottom"><span className="local-icon"><Icon name="code" size={17}/></span><div><strong>Local files. Clear context.</strong><p>Everything stays in your repo.</p></div></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div><Icon name="folder" size={16}/><span>Workspace</span><span className="slash">/</span><strong>File explorer</strong></div><span className="repo-badge"><span className="status-dot"/> Repository only</span></header>
        <main>
          <div className="heading-row"><div><div className="eyebrow">YOUR AGENT KNOWLEDGE, ORGANIZED</div><h1>File explorer<span>.</span></h1><p className="intro">A little structure for everything your agents know.</p></div><span className="md-stamp">.md<span>one place, every context</span></span></div>
          <section className="stats" aria-label="File overview">{(['All files', 'Subagents', 'Workflows', 'Skills'] as const).map((kind, i) => <button key={kind} className={`stat-card ${category === kind && !directory ? 'stat-selected' : ''}`} onClick={() => { setCategory(kind); setDirectory('') }}><span className={`stat-icon tint-${i}`}><Icon name={i === 0 ? 'file' : kindIcons[kind as Kind]} size={20}/></span><span className="stat-label">{kind === 'All files' ? 'Total files' : kind}</span><strong>{kind === 'All files' ? files.length : files.filter(f => f.kind === kind).length}</strong><span className="stat-description">{['Markdown in this repository', 'Specialized agent instructions', 'Repeatable steps and processes', 'Reusable agent capabilities'][i]}</span></button>)}</section>
          <section className="file-section" aria-label="Repository files">
            <div className="list-heading"><div><h2>{directory ? directory.split('/').pop() : category}</h2><span className="count-pill">{visible.length}</span>{directory && <button className="clear-directory" onClick={() => setDirectory('')} aria-label="Clear directory filter"><Icon name="close" size={13}/></button>}</div><span className="list-note">A home for your agent instructions</span></div>
            <div className="toolbar"><label className="search"><Icon name="search"/><input ref={searchRef} value={query} onChange={e => setQuery(e.target.value)} placeholder="Search files or directories…" aria-label="Search files or directories"/>{query ? <button aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={14}/></button> : <kbd>⌘ K</kbd>}</label><label className="sort-label">Sort by: <select aria-label="Sort files" value={sort} onChange={e => setSort(e.target.value)}><option value="name">Name</option><option value="directory">Directory</option></select></label></div>
            <div className="table-scroll"><table><thead><tr><th>File name</th><th>Directory</th><th>Type</th><th className="size-cell">Size</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>{visible.map(file => <tr key={file.path} onClick={() => open(file)}><td><button className="file-name" onClick={e => { e.stopPropagation(); open(file) }}><span className={`file-icon ${file.kind.toLowerCase()}`}><Icon name="file" size={19}/></span><span>{file.name}<small className="mobile-path">{file.directory === '.' ? '/ (root)' : file.directory + '/'}</small>{file.size === 0 && <small>Empty file</small>}</span></button></td><td><button className="path-button" onClick={e => { e.stopPropagation(); setDirectory(file.directory === '.' ? '' : file.directory) }} title={`Filter by ${file.directory}`}><Icon name="folder" size={14}/><span>{file.directory === '.' ? '/ (root)' : file.directory + '/'}</span></button></td><td><span className={`type-badge ${file.kind.toLowerCase()}`}><span/>{file.kind === 'Other' ? 'Markdown' : file.kind === 'Skills' ? 'Skill' : file.kind === 'Workflows' ? 'Workflow' : 'Subagent'}</span></td><td className="size-cell">{formatSize(file.size)}</td><td className="row-arrow"><Icon name="arrow" size={16}/></td></tr>)}</tbody></table></div>
            {visible.length === 0 && <div className="empty-state"><Icon name="search" size={28}/><h3>No files found</h3><p>Try a different name, directory, or file type.</p><button onClick={reset}>Clear all filters</button></div>}
            <div className="table-footer"><span>Showing {visible.length} of {files.length} Markdown files</span><span><span className="status-dot"/> Read-only explorer</span></div>
          </section>
          <div className="scope-note"><span className="scope-icon"><Icon name="folder" size={18}/></span><div><strong>Just your repository. Nothing else.</strong><p>Discovering .md files in this project. Dependencies and Git internals are excluded.</p></div><span className="scope-tag">LOCAL SCOPE</span></div>
          <footer className="page-footer"><span>Less searching. More building.</span><span>md manager <span className="footer-dot">·</span> Your agents’ bookshelf</span></footer>
        </main>
      </div>
      {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><section className="preview" role="dialog" aria-modal="true" aria-label={`Preview ${selected.name}`} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key !== 'Tab') return; const nodes = e.currentTarget.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]'); const first = nodes[0]; const last = nodes[nodes.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() } }}><div className="preview-heading"><div><span className="eyebrow">FILE PREVIEW</span><h2>{selected.name}</h2></div><button ref={closeRef} className="icon-button" aria-label="Close preview" onClick={() => setSelected(null)}><Icon name="close"/></button></div><div className="preview-path"><Icon name="folder" size={15}/>{selected.path}</div><div className="preview-toolbar"><div className="preview-tabs"><button className={!raw ? 'chosen' : ''} onClick={() => setRaw(false)}>Preview</button><button className={raw ? 'chosen' : ''} onClick={() => setRaw(true)}>Source</button></div><button className="copy-button" onClick={async () => { try { await navigator.clipboard.writeText(selected.path); setCopied(true); setCopyError(false) } catch { setCopyError(true) } }}><Icon name={copied ? 'check' : 'copy'} size={14}/>{copied ? 'Copied' : 'Copy path'}</button></div>{copyError && <p role="status">Could not access clipboard. Select the path above to copy it.</p>}<div className="preview-content" tabIndex={0}>{!selected.content.trim() ? <div className="empty-state"><Icon name="file" size={28}/><h3>A blank page, for now.</h3><p>This Markdown file is empty.</p></div> : raw ? <pre>{selected.content}</pre> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[Image: {alt}]</span> }}>{selected.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')}</ReactMarkdown>}</div><div className="preview-footer">{formatSize(selected.size)}<span>Read-only · Repository file</span></div></section></div>}
    </div>
  )
}
export default App
