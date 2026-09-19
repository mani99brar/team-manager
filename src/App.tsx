import { useEffect, useState } from 'react'
import './App.css'

type Source = 'pi' | 'claude'

interface MarkdownFile {
  source: Source
  path: string
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; files: MarkdownFile[] }

const SOURCE_LABEL: Record<Source, string> = { pi: 'Pi', claude: 'Claude' }

function App() {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/files', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server responded with ${res.status}`)
        const body = (await res.json()) as { files: MarkdownFile[] }
        setState({ status: 'ready', files: body.files })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        setState({ status: 'error', message })
      })
    return () => controller.abort()
  }, [])

  return (
    <main>
      <h1>MD Manager</h1>
      <p className="subtitle">Markdown files under the Pi and Claude folders</p>

      {state.status === 'loading' && (
        <p className="status" role="status">
          Loading files…
        </p>
      )}

      {state.status === 'error' && (
        <p className="status error" role="alert">
          Could not load files: {state.message}
        </p>
      )}

      {state.status === 'ready' && state.files.length === 0 && (
        <p className="status">No Markdown files found.</p>
      )}

      {state.status === 'ready' && state.files.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Path</th>
            </tr>
          </thead>
          <tbody>
            {state.files.map((file) => (
              <tr key={`${file.source}/${file.path}`}>
                <td>
                  <span className={`badge ${file.source}`}>
                    {SOURCE_LABEL[file.source]}
                  </span>
                </td>
                <td>
                  <code>{file.path}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

export default App
