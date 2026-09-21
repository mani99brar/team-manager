import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'

// ---- The isolated harness (see playwright.config.ts) ------------------------------------------------

export const PI = 'pi-personal'
export const PI_PACKAGE = 'pi-package'
export const PI_MISSING = 'pi-missing'
export const CLAUDE = 'claude-personal'
export const CLAUDE_PLUGIN = 'claude-plugin'

export const LABELS: Record<string, string> = {
  [PI]: 'Personal skills',
  [PI_PACKAGE]: 'Package: demo',
  [PI_MISSING]: 'Project: gone',
  [CLAUDE]: 'Personal and synced skills',
  [CLAUDE_PLUGIN]: 'Plugin: design',
}

/** The temporary root holding every location directory; never the repository fixtures. */
export const testRoot = (() => {
  const root = process.env.MD_MANAGER_TEST_ROOT
  if (!root) throw new Error('MD_MANAGER_TEST_ROOT is not set: run through playwright.config.ts')
  return root
})()

export const roots = {
  piPersonal: join(testRoot, PI),
  piPackage: join(testRoot, PI_PACKAGE),
  /** Configured but absent until a test creates it (and removes it again). */
  piMissing: join(testRoot, PI_MISSING),
  claudePersonal: join(testRoot, CLAUDE),
  claudePlugin: join(testRoot, CLAUDE_PLUGIN),
}

export const SEEDED_LOCATIONS = [
  { id: PI, source: 'Pi', label: LABELS[PI], category: 'personal', status: 'available', error: null },
  { id: PI_PACKAGE, source: 'Pi', label: LABELS[PI_PACKAGE], category: 'package', status: 'available', error: null },
  { id: PI_MISSING, source: 'Pi', label: LABELS[PI_MISSING], category: 'project', status: 'unavailable', error: expect.stringMatching(/does not exist/) },
  { id: CLAUDE, source: 'Claude', label: LABELS[CLAUDE], category: 'personal', status: 'available', error: null },
  { id: CLAUDE_PLUGIN, source: 'Claude', label: LABELS[CLAUDE_PLUGIN], category: 'plugin', status: 'available', error: null },
]

/** What the seeded roots list before any spec adds scratch artifacts. */
export const SEEDED_ENTRIES = [
  { source: 'Pi', locationId: PI, path: 'skills', kind: 'directory' },
  { source: 'Pi', locationId: PI, path: 'skills/review.md', kind: 'file' },
  { source: 'Pi', locationId: PI, path: 'workflow.md', kind: 'file' },
  { source: 'Pi', locationId: PI_PACKAGE, path: 'review', kind: 'directory' },
  { source: 'Pi', locationId: PI_PACKAGE, path: 'review/SKILL.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE, path: 'empty.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE, path: 'subagents', kind: 'directory' },
  { source: 'Claude', locationId: CLAUDE, path: 'subagents/implementer.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE, path: 'workflow.md', kind: 'file' },
  { source: 'Claude', locationId: CLAUDE_PLUGIN, path: 'review', kind: 'directory' },
  { source: 'Claude', locationId: CLAUDE_PLUGIN, path: 'review/SKILL.md', kind: 'file' },
]

/** Seeded listing summary as the app announces it. */
export const SEEDED_SUMMARY = '4 folders and 7 Markdown files across 5 locations, 1 unavailable'

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function browseUrl(source: 'Pi' | 'Claude', locationId?: string, path = ''): string {
  if (!locationId) return `/browse/${source}`
  return path ? `/browse/${source}/${locationId}/${encodePath(path)}` : `/browse/${source}/${locationId}`
}

export function fileUrl(source: 'Pi' | 'Claude', locationId: string, path: string): string {
  return `/file/${source}/${locationId}/${encodePath(path)}`
}

// ---- Page helpers ---------------------------------------------------------------------------------

/** The API starts alongside Vite; wait until the proxy reaches it before loading the page. */
export async function waitForApi(request: APIRequestContext) {
  await expect.poll(async () => (await request.get('/api/entries')).status(), { timeout: 30_000 }).toBe(200)
}

export async function openGraph(page: Page, path = '/') {
  await page.goto(path)
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(node(page, 'Pi')).toBeVisible()
}

/** A graph node wrapper by id ("Pi", "Pi/pi-personal", "Pi/pi-personal/skills", "Claude/claude-personal/workflow.md"). */
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

/** Frames every visible node inside the canvas so nothing sits behind the toolbars or the legend. */
export async function fit(page: Page) {
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
}

/** Expands a source and one of its locations in the graph, fitting the view so the revealed children are clickable. */
export async function expandLocation(page: Page, source: 'Pi' | 'Claude', locationId: string) {
  await fit(page)
  if (await expandButton(page, source).count()) await expandButton(page, source).click()
  await fit(page)
  await expect(node(page, `${source}/${locationId}`)).toBeVisible()
  if (await expandButton(page, LABELS[locationId]).count()) await expandButton(page, LABELS[locationId]).click()
  await fit(page)
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
