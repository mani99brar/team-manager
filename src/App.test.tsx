// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const fixtureFiles = [
  { source: 'claude', path: 'empty.md' },
  { source: 'claude', path: 'subagents/implementer.md' },
  { source: 'claude', path: 'workflow.md' },
  { source: 'pi', path: 'skills/review.md' },
  { source: 'pi', path: 'workflow.md' },
]

let container: HTMLDivElement
let root: Root

async function render() {
  await act(async () => {
    root.render(<App />)
  })
}

function rows() {
  return Array.from(container.querySelectorAll('tbody tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim()),
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('shows a loading message while the request is pending', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    await render()
    expect(container.querySelector('[role=status]')?.textContent).toContain(
      'Loading files',
    )
    expect(container.querySelector('table')).toBeNull()
  })

  it('lists every file with its source label and relative path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ files: fixtureFiles })),
    )
    await render()
    expect(rows()).toEqual([
      ['Claude', 'empty.md'],
      ['Claude', 'subagents/implementer.md'],
      ['Claude', 'workflow.md'],
      ['Pi', 'skills/review.md'],
      ['Pi', 'workflow.md'],
    ])
    expect(container.querySelector('.status')).toBeNull()
  })

  it('shows an empty message when there are no files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ files: [] })))
    await render()
    expect(container.querySelector('.status')?.textContent).toBe(
      'No Markdown files found.',
    )
    expect(container.querySelector('table')).toBeNull()
  })

  it('shows an error message when the server responds with an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    await render()
    expect(container.querySelector('[role=alert]')?.textContent).toBe(
      'Could not load files: Server responded with 500',
    )
  })

  it('shows an error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await render()
    expect(container.querySelector('[role=alert]')?.textContent).toBe(
      'Could not load files: Failed to fetch',
    )
  })
})
