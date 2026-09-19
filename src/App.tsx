import { useEffect, useState } from 'react'
import './App.css'

type MarkdownFile = { source: 'Pi' | 'Claude'; path: string }
type ListingState =
  | { status: 'loading' }
  | { status: 'ready'; files: MarkdownFile[] }
  | { status: 'error' }

function App() {
  const [state, setState] = useState<ListingState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await fetch('/api/files', { signal: controller.signal })
        if (!response.ok) throw new Error('Listing failed')
        const data = await response.json() as { files: MarkdownFile[] }
        if (!controller.signal.aborted) setState({ status: 'ready', files: data.files })
      } catch {
        if (!controller.signal.aborted) setState({ status: 'error' })
      }
    }
    void load()
    return () => controller.abort()
  }, [])

  return (
    <main>
      <h1>MD Manager</h1>
      <p>Markdown files in the Pi and Claude fixtures. Paths are relative to each source folder.</p>
      {state.status === 'loading' && <p role="status">Loading Markdown files…</p>}
      {state.status === 'error' && (
        <p role="alert">Unable to load Markdown files. Check that the API is running and both fixture folders are readable, then reload the page.</p>
      )}
      {state.status === 'ready' && (state.files.length === 0
        ? <p role="status">No Markdown files found in the Pi or Claude fixture folders.</p>
        : <>
            <p role="status">{state.files.length} Markdown files</p>
            <table>
              <caption>Available Markdown files</caption>
              <thead><tr><th scope="col">Source</th><th scope="col">Relative path</th></tr></thead>
              <tbody>{state.files.map(file => (
                <tr key={`${file.source}/${file.path}`}>
                  <td>{file.source}</td><td><code>{file.path}</code></td>
                </tr>
              ))}</tbody>
            </table>
          </>)}
    </main>
  )
}

export default App
