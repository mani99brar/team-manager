import { test, expect } from '@playwright/test'
import {
  COMMITTED_ENTRIES,
  collapseButton,
  currentCrumb,
  dragNode,
  edge,
  expandButton,
  folderInfo,
  node,
  nodeBody,
  nodeCenter,
  openGraph,
  visibleNodeIds,
  viewTransform,
  waitForApi,
} from './helpers.ts'

test.beforeEach(async ({ request }) => { await waitForApi(request) })

test('initial view shows only the two source nodes, fitted and unconnected', async ({ page, request }) => {
  expect((await (await request.get('/api/entries')).json()).entries).toEqual(COMMITTED_ENTRIES)
  await openGraph(page)
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
  await expect(page.locator('.graph-canvas line')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Pi, source folder, 1 folder, 1 Markdown file/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Claude, source folder, 1 folder, 2 Markdown files/ })).toBeVisible()
  await expect(currentCrumb(page)).toHaveText('Home')
  await expect(folderInfo(page)).toContainText('Two sources')
  await expect(page.getByRole('status')).toContainText('Loaded 2 folders and 5 Markdown files.')
  await expect(page.getByRole('contentinfo')).toContainText('Contains (parent → child)')
  // No document contents are ever requested.
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await expandButton(page, 'Pi').click()
  await expandButton(page, 'skills').click()
  expect(requests.filter(url => url.includes('/api/'))).toEqual([])
})

test('expansion reveals immediate children with containment edges; collapse hides descendants', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Pi/skills', 'Pi/workflow.md', 'Claude'])
  await expect(edge(page, 'Pi', 'Pi/skills')).toBeVisible()
  await expect(edge(page, 'Pi', 'Pi/workflow.md')).toBeVisible()
  await expect(page.locator('.graph-canvas line')).toHaveCount(2)
  await expect(page.getByRole('status')).toHaveText('Expanded Pi: 1 folder, 1 Markdown file')
  await expect(node(page, 'Pi/skills/review.md')).toHaveCount(0)

  await expandButton(page, 'skills').click()
  await expect(node(page, 'Pi/skills/review.md')).toBeVisible()
  await expect(edge(page, 'Pi/skills', 'Pi/skills/review.md')).toBeVisible()
  // File nodes are actions that open the document (covered in document.spec.ts); they never select a folder.
  await expect(page.getByRole('button', { name: 'review.md, Markdown file', exact: true })).toBeVisible()

  // Pi and Claude are never connected to each other.
  await expandButton(page, 'Claude').click()
  const parents = await page.locator('.graph-canvas line').evaluateAll(lines => lines.map(line => [line.getAttribute('data-edge-parent'), line.getAttribute('data-edge-child')]))
  for (const [parent, child] of parents) expect(child!.startsWith(`${parent}/`)).toBe(true)

  await collapseButton(page, 'Pi').click()
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude', 'Claude/subagents', 'Claude/empty.md', 'Claude/workflow.md'])
  await expect(page.getByRole('status')).toHaveText('Collapsed Pi.')
  // Collapsing cleared the nested expansion state.
  await expandButton(page, 'Pi').click()
  await expect(node(page, 'Pi/skills')).toBeVisible()
  await expect(node(page, 'Pi/skills/review.md')).toHaveCount(0)
  await expect(expandButton(page, 'skills')).toBeVisible()
})

test('selecting folders updates breadcrumb, counts, highlight and URL; history works', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Pi').click()
  await expect(page).toHaveURL('/Pi')
  await expect(currentCrumb(page)).toHaveText('Pi')
  await expect(folderInfo(page)).toHaveText('1 folder, 1 Markdown file')
  await expect(node(page, 'Pi')).toHaveClass(/is-selected/)
  // Selection does not expand.
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])

  await expandButton(page, 'Pi').click()
  await nodeBody(page, 'Pi/skills').click()
  await expect(page).toHaveURL('/Pi/skills')
  await expect(currentCrumb(page)).toHaveText('skills')
  await expect(folderInfo(page)).toHaveText('0 folders, 1 Markdown file')
  await expect(edge(page, 'Pi', 'Pi/skills')).toHaveClass(/edge-highlight/)
  await expect(edge(page, 'Pi', 'Pi/workflow.md')).not.toHaveClass(/edge-highlight/)
  await expect(page.getByRole('button', { name: /^skills, folder/ })).toHaveAttribute('aria-pressed', 'true')

  await page.goBack()
  await expect(page).toHaveURL('/Pi')
  await expect(currentCrumb(page)).toHaveText('Pi')
  await page.goForward()
  await expect(page).toHaveURL('/Pi/skills')
  await expect(currentCrumb(page)).toHaveText('skills')

  // Breadcrumb navigation selects the ancestor without collapsing anything.
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Pi' }).click()
  await expect(page).toHaveURL('/Pi')
  await expect(node(page, 'Pi/skills')).toBeVisible()
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL('/')
  await expect(currentCrumb(page)).toHaveText('Home')
  await expect(node(page, 'Pi/skills')).toBeVisible()
})

test('direct links reveal the ancestor chain, expand the folder and survive reload', async ({ page }) => {
  await openGraph(page, '/Claude/subagents')
  await expect(currentCrumb(page)).toHaveText('subagents')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude', 'Claude/subagents', 'Claude/subagents/implementer.md', 'Claude/empty.md', 'Claude/workflow.md'])
  await expect(node(page, 'Claude/subagents')).toHaveClass(/is-selected/)
  await expect(node(page, 'Claude/subagents')).toBeInViewport()
  await expect(collapseButton(page, 'subagents')).toBeVisible()
  await page.reload()
  await expect(currentCrumb(page)).toHaveText('subagents')
  await expect(node(page, 'Claude/subagents/implementer.md')).toBeVisible()
})

test('collapsing an ancestor of the selected folder selects the collapsing node', async ({ page }) => {
  await openGraph(page, '/Pi/skills')
  await collapseButton(page, 'Pi').click()
  await expect(page).toHaveURL('/Pi')
  await expect(currentCrumb(page)).toHaveText('Pi')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
})

test('missing folders and unknown sources explain themselves and link to a root', async ({ page }) => {
  await openGraph(page, '/Pi/does-not-exist')
  await expect(page.getByRole('alert')).toContainText('Folder “does-not-exist” was not found in Pi')
  await expect(currentCrumb(page)).toHaveText('does-not-exist')
  await page.getByRole('link', { name: 'Go to the Pi root' }).click()
  await expect(page).toHaveURL('/Pi')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(folderInfo(page)).toHaveText('1 folder, 1 Markdown file')

  await openGraph(page, '/Nope/anything')
  await expect(page.getByRole('alert')).toContainText('Source “Nope” does not exist')
  await page.getByRole('link', { name: 'Go to the Claude root' }).click()
  await expect(page).toHaveURL('/Claude')
})

test('dragging pins a node without selecting it; unpin and reset clear pins', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  const before = await nodeCenter(page, 'Pi/skills')
  await dragNode(page, 'Pi/skills', 140, 90)
  const after = await nodeCenter(page, 'Pi/skills')
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(100)
  await expect(page).toHaveURL('/')
  await expect(node(page, 'Pi/skills')).toHaveClass(/is-pinned/)
  await expect(page.getByRole('button', { name: /^skills, folder.*pinned$/ })).toBeVisible()

  // Pins survive selection changes and stay where they were put.
  await nodeBody(page, 'Pi').click()
  await expect(page).toHaveURL('/Pi')
  const afterSelect = await nodeCenter(page, 'Pi/skills')
  expect(Math.abs(afterSelect.x - after.x)).toBeLessThan(1)
  expect(Math.abs(afterSelect.y - after.y)).toBeLessThan(1)

  await page.getByRole('button', { name: 'Unpin skills' }).click()
  await expect(node(page, 'Pi/skills')).not.toHaveClass(/is-pinned/)
  await expect(page.getByRole('status')).toHaveText('Unpinned skills.')

  await dragNode(page, 'Pi', -120, 60)
  await expect(node(page, 'Pi')).toHaveClass(/is-pinned/)
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page).toHaveURL('/')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
  await expect(page.locator('.graph-canvas .is-pinned')).toHaveCount(0)
  await expect(currentCrumb(page)).toHaveText('Home')
})

test('keyboard: outline-order tabbing, Enter selects, arrows expand/collapse, P pins', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Pi').focus()
  await page.keyboard.press('ArrowRight')
  await expect(node(page, 'Pi/skills')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/Pi')
  await page.keyboard.press('p')
  await expect(node(page, 'Pi')).toHaveClass(/is-pinned/)
  await page.keyboard.press('p')
  await expect(node(page, 'Pi')).not.toHaveClass(/is-pinned/)

  // Tab order follows the outline: Pi body, Pi toggle, skills body, skills toggle, workflow.md, Claude…
  await page.keyboard.press('Tab')
  await expect(collapseButton(page, 'Pi')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, 'Pi/skills')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(expandButton(page, 'skills')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, 'Pi/workflow.md')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, 'Claude')).toBeFocused()

  await nodeBody(page, 'Pi/skills').focus()
  await page.keyboard.press('ArrowRight')
  await expect(node(page, 'Pi/skills/review.md')).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page).toHaveURL('/Pi/skills')
  await page.keyboard.press('ArrowLeft')
  await expect(node(page, 'Pi/skills/review.md')).toHaveCount(0)
  // Toggles are keyboard operable too.
  await collapseButton(page, 'Pi').focus()
  await page.keyboard.press('Enter')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
  await expect(page).toHaveURL('/Pi')
})

test('keyboard focus reveals off-screen node bodies, expand controls and pin controls', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Pi').focus()
  await page.keyboard.press('p')

  const canvas = page.locator('.graph-canvas')
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Graph canvas has no bounding box')
  const panAway = async () => {
    await page.mouse.move(bounds.x + 10, bounds.y + 10)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width + 500, bounds.y + 10)
    await page.mouse.up()
    await expect(nodeBody(page, 'Pi')).not.toBeInViewport()
  }

  await panAway()
  // Outline is the last toolbar button before the graph in DOM order.
  await page.getByRole('button', { name: 'Outline', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, 'Pi')).toBeFocused()
  await expect(nodeBody(page, 'Pi')).toBeInViewport({ ratio: 1 })

  await panAway()
  await expandButton(page, 'Pi').focus()
  await expect(expandButton(page, 'Pi')).toBeFocused()
  await expect(expandButton(page, 'Pi')).toBeInViewport({ ratio: 1 })

  await panAway()
  const unpin = page.getByRole('button', { name: 'Unpin Pi', exact: true })
  await unpin.focus()
  await expect(unpin).toBeFocused()
  await expect(unpin).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveURL('/')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
})

test('outline mode replaces the graph and shares selection, expansion, breadcrumbs and refresh', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await page.getByRole('button', { name: 'Outline' }).click()
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-pressed', 'true')
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await expect(outline.locator('[data-node-id="Pi/skills"]')).toBeVisible()
  await expect(outline.locator('[data-node-id="Claude/subagents"]')).toHaveCount(0)
  await expect(outline.locator('[data-node-id="Pi/skills/review.md"]')).toHaveCount(0)

  await outline.getByRole('button', { name: 'Expand skills' }).click()
  await expect(outline.locator('[data-node-id="Pi/skills/review.md"]')).toContainText('review.md')
  await expect(outline.locator('[data-node-id="Pi/skills/review.md"]')).toContainText('Markdown file')
  await outline.getByRole('button', { name: /^skills\s*, folder$/ }).click()
  await expect(page).toHaveURL('/Pi/skills')
  await expect(currentCrumb(page)).toHaveText('skills')
  await expect(outline.getByRole('button', { name: /^skills\s*, folder$/ })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('status')).toContainText('Refreshed')

  // Back to the graph: the same expansion and selection are shown.
  await page.getByRole('button', { name: 'Outline' }).click()
  await expect(node(page, 'Pi/skills/review.md')).toBeVisible()
  await expect(node(page, 'Pi/skills')).toHaveClass(/is-selected/)
})

test('zoom, fit and empty-folder display', async ({ page }) => {
  await openGraph(page)
  const initial = await viewTransform(page)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  expect((await viewTransform(page)).k).toBeGreaterThan(initial.k)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  expect((await viewTransform(page)).k).toBeLessThan(initial.k)
  await page.getByRole('button', { name: 'Fit' }).click()
  expect(Math.abs((await viewTransform(page)).k - initial.k)).toBeLessThan(0.001)

  await page.route('**/api/entries', route => route.fulfill({ json: { entries: [{ source: 'Claude', path: 'nothing-here', kind: 'directory' }] } }))
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expandButton(page, 'Pi').click()
  await expect(page.getByRole('button', { name: 'Pi, source folder, This folder is empty.' })).toBeVisible()
  await expect(node(page, 'Pi').locator('.empty-tag')).toHaveText('empty')
  await nodeBody(page, 'Pi').click()
  await expect(folderInfo(page)).toHaveText('This folder is empty.')
  await expandButton(page, 'Claude').click()
  await expect(node(page, 'Claude/nothing-here')).toBeVisible()
  await nodeBody(page, 'Claude/nothing-here').click()
  await expect(folderInfo(page)).toHaveText('This folder is empty.')
})

test('loading state, initial failure with retry, and network failure', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let mode: 'gated-failure' | 'network-failure' | 'ok' = 'gated-failure'
  await page.route('**/api/entries', async route => {
    try {
      if (mode === 'gated-failure') {
        await gate
        await route.fulfill({ status: 500, json: { error: 'Unable to read the Claude fixture folder. Check that both fixture folders exist and are readable, then refresh.' } })
      } else if (mode === 'network-failure') {
        await route.abort()
      } else {
        await route.continue()
      }
    } catch {
      // The page may have cancelled the request (React strict mode aborts the first effect run).
    }
  })
  await page.goto('/')
  await expect(page.getByText('Loading the Pi and Claude fixture folders…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  release()
  await expect(page.getByRole('alert')).toContainText('Unable to read the Claude fixture folder')
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  mode = 'network-failure'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('alert')).toContainText('The API could not be reached')
  mode = 'ok'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(node(page, 'Claude')).toBeVisible()
})

test('refresh keeps the previous graph and warns when the API fails', async ({ page }) => {
  await openGraph(page, '/Pi/skills')
  await page.route('**/api/entries', route => route.fulfill({ status: 500, json: { error: 'Unable to read the Pi fixture folder. Check that both fixture folders exist and are readable, then refresh.' } }))
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('alert')).toContainText('may be outdated')
  await expect(page.getByRole('alert')).toContainText('Unable to read the Pi fixture folder')
  await expect(node(page, 'Pi/skills/review.md')).toBeVisible()
  await expect(currentCrumb(page)).toHaveText('skills')
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  await page.unroute('**/api/entries')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('narrow screens keep controls reachable without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await openGraph(page, '/Claude/subagents')
  for (const name of ['Refresh', 'Zoom in', 'Zoom out', 'Fit', 'Reset', 'Outline']) {
    await expect(page.getByRole('button', { name })).toBeInViewport()
  }
  const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(node(page, 'Claude/subagents')).toBeInViewport()
})
