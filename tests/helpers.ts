import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

export const COMMITTED_ENTRIES = [
  { source: 'Pi', path: 'skills', kind: 'directory' },
  { source: 'Pi', path: 'skills/review.md', kind: 'file' },
  { source: 'Pi', path: 'workflow.md', kind: 'file' },
  { source: 'Claude', path: 'empty.md', kind: 'file' },
  { source: 'Claude', path: 'subagents', kind: 'directory' },
  { source: 'Claude', path: 'subagents/implementer.md', kind: 'file' },
  { source: 'Claude', path: 'workflow.md', kind: 'file' },
]

/** The API starts alongside Vite; wait until the proxy reaches it before loading the page. */
export async function waitForApi(request: APIRequestContext) {
  await expect.poll(async () => (await request.get('/api/entries')).status(), { timeout: 30_000 }).toBe(200)
}

export async function openGraph(page: Page, path = '/') {
  await page.goto(path)
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(node(page, 'Pi')).toBeVisible()
}

/** A graph node wrapper by id ("Pi", "Pi/skills", "Claude/workflow.md"). */
export function node(page: Page, id: string): Locator {
  return page.locator(`.graph-canvas [data-node-id="${id}"]`)
}

export function nodeBody(page: Page, id: string): Locator {
  return node(page, id).locator('.node-body')
}

export function edge(page: Page, parentId: string, childId: string): Locator {
  return page.locator(`.graph-canvas line[data-edge-parent="${parentId}"][data-edge-child="${childId}"]`)
}

export function expandButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name: `Expand ${name}`, exact: true })
}

export function collapseButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name: `Collapse ${name}`, exact: true })
}

export function currentCrumb(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Breadcrumb' }).locator('[aria-current="page"]')
}

export function folderInfo(page: Page): Locator {
  return page.getByTestId('folder-info')
}

export function visibleNodeIds(page: Page): Promise<string[]> {
  return page.locator('.graph-canvas .node').evaluateAll(elements => elements.map(element => element.getAttribute('data-node-id') ?? ''))
}

/** Drags a node body by a screen offset using real pointer events. */
export async function dragNode(page: Page, id: string, dx: number, dy: number) {
  const box = await nodeBody(page, id).locator('.shape').first().boundingBox()
  if (!box) throw new Error(`Node ${id} has no bounding box`)
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 5 })
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 })
  await page.mouse.up()
}

export async function nodeCenter(page: Page, id: string) {
  const box = await nodeBody(page, id).locator('.shape').first().boundingBox()
  if (!box) throw new Error(`Node ${id} has no bounding box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

export async function viewTransform(page: Page): Promise<{ x: number; y: number; k: number }> {
  const transform = await page.locator('.graph-canvas > g').getAttribute('transform')
  const match = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(transform ?? '')
  if (!match) throw new Error(`Unexpected transform ${transform}`)
  return { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) }
}
