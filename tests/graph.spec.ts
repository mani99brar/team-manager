import { test, expect } from '@playwright/test'
import {
  CLAUDE,
  CLAUDE_PLUGIN,
  LABELS,
  PI,
  PI_MISSING,
  PI_PACKAGE,
  SEEDED_ENTRIES,
  SEEDED_LOCATIONS,
  SEEDED_SUMMARY,
  browseUrl,
  collapseButton,
  currentCrumb,
  dragNode,
  edge,
  expandButton,
  expandLocation,
  fit,
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

test('initial view shows only the two source nodes, fitted and unconnected; the listing carries locations', async ({ page, request }) => {
  const listing = await (await request.get('/api/entries')).json()
  expect(listing.locations).toEqual(SEEDED_LOCATIONS)
  expect(listing.entries).toEqual(SEEDED_ENTRIES)
  await openGraph(page)
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
  await expect(page.locator('.graph-canvas line')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Pi, source, 3 locations/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Claude, source, 2 locations/ })).toBeVisible()
  await expect(currentCrumb(page)).toHaveText('Home')
  await expect(folderInfo(page)).toContainText('Two sources')
  await expect(page.getByRole('status')).toContainText(`Loaded ${SEEDED_SUMMARY}.`)
  await expect(page.getByRole('contentinfo')).toContainText('Location')
  await expect(page.getByRole('contentinfo')).toContainText('Contains (parent → child)')
  // No document contents are ever requested.
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  await expandLocation(page, 'Pi', PI)
  await expandButton(page, 'skills').click()
  expect(requests.filter(url => url.includes('/api/'))).toEqual([])
})

test('expansion reveals locations, then their immediate children with containment edges; collapse hides descendants', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  expect(await visibleNodeIds(page)).toEqual(['Pi', `Pi/${PI}`, `Pi/${PI_PACKAGE}`, `Pi/${PI_MISSING}`, 'Claude'])
  await expect(page.locator('.graph-canvas line')).toHaveCount(3)
  await expect(page.getByRole('status')).toHaveText('Expanded Pi: 3 locations')
  await expect(page.getByRole('button', { name: `${LABELS[PI]}, location, 1 folder, 1 Markdown file`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `${LABELS[PI_PACKAGE]}, location, 1 folder, 0 Markdown files`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `${LABELS[PI_MISSING]}, location, unavailable`, exact: true })).toBeVisible()
  await expect(node(page, `Pi/${PI_MISSING}`)).toHaveClass(/is-unavailable/)

  await fit(page)
  await expandButton(page, LABELS[PI]).click()
  await fit(page)
  expect(await visibleNodeIds(page)).toEqual(['Pi', `Pi/${PI}`, `Pi/${PI}/skills`, `Pi/${PI}/workflow.md`, `Pi/${PI_PACKAGE}`, `Pi/${PI_MISSING}`, 'Claude'])
  await expect(edge(page, `Pi/${PI}`, `Pi/${PI}/skills`)).toBeVisible()
  await expect(edge(page, `Pi/${PI}`, `Pi/${PI}/workflow.md`)).toBeVisible()
  await expect(page.getByRole('status')).toHaveText(`Expanded ${LABELS[PI]}: 1 folder, 1 Markdown file`)
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toHaveCount(0)

  await expandButton(page, 'skills').click()
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toBeVisible()
  await expect(edge(page, `Pi/${PI}/skills`, `Pi/${PI}/skills/review.md`)).toBeVisible()
  // File nodes are actions that open the document (covered in document.spec.ts); they never select a folder.
  await expect(page.getByRole('button', { name: 'review.md, Markdown file', exact: true })).toBeVisible()

  // Pi and Claude are never connected to each other; every edge is containment.
  await fit(page)
  await expandButton(page, 'Claude').click()
  const parents = await page.locator('.graph-canvas line').evaluateAll(lines => lines.map(line => [line.getAttribute('data-edge-parent'), line.getAttribute('data-edge-child')]))
  for (const [parent, child] of parents) expect(child!.startsWith(`${parent}/`)).toBe(true)

  await collapseButton(page, 'Pi').click()
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude', `Claude/${CLAUDE}`, `Claude/${CLAUDE_PLUGIN}`])
  await expect(page.getByRole('status')).toHaveText('Collapsed Pi.')
  // Collapsing cleared the nested expansion state.
  await expandButton(page, 'Pi').click()
  await expect(node(page, `Pi/${PI}`)).toBeVisible()
  await expect(node(page, `Pi/${PI}/skills`)).toHaveCount(0)
  await expect(expandButton(page, LABELS[PI])).toBeVisible()
})

test('selecting sources, locations and folders updates breadcrumb, counts, highlight and URL; history works', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Pi').click()
  await expect(page).toHaveURL('/browse/Pi')
  await expect(currentCrumb(page)).toHaveText('Pi')
  await expect(folderInfo(page)).toHaveText('3 locations')
  await expect(node(page, 'Pi')).toHaveClass(/is-selected/)
  // Selection does not expand.
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])

  await expandButton(page, 'Pi').click()
  await fit(page)
  await nodeBody(page, `Pi/${PI}`).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(currentCrumb(page)).toHaveText(LABELS[PI])
  await expect(folderInfo(page)).toHaveText('1 folder, 1 Markdown file')
  await expect(edge(page, 'Pi', `Pi/${PI}`)).toHaveClass(/edge-highlight/)
  await expect(edge(page, 'Pi', `Pi/${PI_PACKAGE}`)).not.toHaveClass(/edge-highlight/)

  await expandButton(page, LABELS[PI]).click()
  await fit(page)
  await nodeBody(page, `Pi/${PI}/skills`).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, 'skills'))
  await expect(currentCrumb(page)).toHaveText('skills')
  await expect(folderInfo(page)).toHaveText('0 folders, 1 Markdown file')
  await expect(edge(page, `Pi/${PI}`, `Pi/${PI}/skills`)).toHaveClass(/edge-highlight/)
  await expect(edge(page, `Pi/${PI}`, `Pi/${PI}/workflow.md`)).not.toHaveClass(/edge-highlight/)
  await expect(page.getByRole('button', { name: /^skills, folder/ })).toHaveAttribute('aria-pressed', 'true')

  await page.goBack()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(currentCrumb(page)).toHaveText(LABELS[PI])
  await page.goForward()
  await expect(page).toHaveURL(browseUrl('Pi', PI, 'skills'))
  await expect(currentCrumb(page)).toHaveText('skills')

  // Breadcrumb navigation selects the ancestor without collapsing anything: Home / Pi / Personal skills / skills.
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(breadcrumb.getByRole('link')).toHaveText(['Home', 'Pi', LABELS[PI], 'skills'])
  await breadcrumb.getByRole('link', { name: LABELS[PI] }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(node(page, `Pi/${PI}/skills`)).toBeVisible()
  await breadcrumb.getByRole('link', { name: 'Pi' }).click()
  await expect(page).toHaveURL('/browse/Pi')
  await expect(node(page, `Pi/${PI}/skills`)).toBeVisible()
  await breadcrumb.getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL('/')
  await expect(currentCrumb(page)).toHaveText('Home')
  await expect(node(page, `Pi/${PI}/skills`)).toBeVisible()
})

test('direct links reveal the source, location and ancestor chain, expand the folder and survive reload', async ({ page }) => {
  await openGraph(page, browseUrl('Claude', CLAUDE, 'subagents'))
  await expect(currentCrumb(page)).toHaveText('subagents')
  expect(await visibleNodeIds(page)).toEqual([
    'Pi', 'Claude', `Claude/${CLAUDE}`, `Claude/${CLAUDE}/subagents`, `Claude/${CLAUDE}/subagents/implementer.md`,
    `Claude/${CLAUDE}/empty.md`, `Claude/${CLAUDE}/workflow.md`, `Claude/${CLAUDE_PLUGIN}`,
  ])
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toHaveClass(/is-selected/)
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toBeInViewport()
  await expect(collapseButton(page, 'subagents')).toBeVisible()
  await page.reload()
  await expect(currentCrumb(page)).toHaveText('subagents')
  await expect(node(page, `Claude/${CLAUDE}/subagents/implementer.md`)).toBeVisible()

  // A location link expands the source and the location.
  await openGraph(page, browseUrl('Pi', PI_PACKAGE))
  await expect(currentCrumb(page)).toHaveText(LABELS[PI_PACKAGE])
  await expect(node(page, `Pi/${PI_PACKAGE}/review`)).toBeVisible()
  await expect(node(page, `Pi/${PI_PACKAGE}`)).toHaveClass(/is-selected/)
})

test('collapsing an ancestor of the selected folder selects the collapsing node', async ({ page }) => {
  await openGraph(page, browseUrl('Pi', PI, 'skills'))
  await collapseButton(page, LABELS[PI]).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(currentCrumb(page)).toHaveText(LABELS[PI])
  await collapseButton(page, 'Pi').click()
  await expect(page).toHaveURL('/browse/Pi')
  await expect(currentCrumb(page)).toHaveText('Pi')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
})

test('missing folders, unknown sources and unconfigured locations explain themselves and link to a root', async ({ page }) => {
  await openGraph(page, browseUrl('Pi', PI, 'does-not-exist'))
  await expect(page.getByRole('alert')).toContainText(`Folder “does-not-exist” was not found in Pi / ${LABELS[PI]}`)
  await expect(currentCrumb(page)).toHaveText('does-not-exist')
  await page.getByRole('link', { name: `Go to ${LABELS[PI]}` }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(folderInfo(page)).toHaveText('1 folder, 1 Markdown file')

  await openGraph(page, '/browse/Nope/anything')
  await expect(page.getByRole('alert')).toContainText('Source “Nope” does not exist')
  await page.getByRole('link', { name: 'Go to the Claude root' }).click()
  await expect(page).toHaveURL('/browse/Claude')

  await openGraph(page, '/browse/Pi/not-configured/x')
  await expect(page.getByRole('alert')).toContainText('Location “not-configured” is not configured under Pi')
  await expect(page.getByRole('alert').getByRole('link', { name: LABELS[PI_MISSING] + ' (unavailable)' })).toBeVisible()
  await page.getByRole('alert').getByRole('link', { name: LABELS[PI_PACKAGE] }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI_PACKAGE))
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('dragging pins a node without selecting it; unpin and reset clear pins', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  const before = await nodeCenter(page, `Pi/${PI}`)
  await dragNode(page, `Pi/${PI}`, 140, 90)
  const after = await nodeCenter(page, `Pi/${PI}`)
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(100)
  await expect(page).toHaveURL('/')
  await expect(node(page, `Pi/${PI}`)).toHaveClass(/is-pinned/)
  await expect(page.getByRole('button', { name: new RegExp(`^${LABELS[PI]}, location.*pinned$`) })).toBeVisible()

  // Pins survive selection changes and stay where they were put.
  await nodeBody(page, 'Pi').click()
  await expect(page).toHaveURL('/browse/Pi')
  const afterSelect = await nodeCenter(page, `Pi/${PI}`)
  expect(Math.abs(afterSelect.x - after.x)).toBeLessThan(1)
  expect(Math.abs(afterSelect.y - after.y)).toBeLessThan(1)

  await page.getByRole('button', { name: `Unpin ${LABELS[PI]}` }).click()
  await expect(node(page, `Pi/${PI}`)).not.toHaveClass(/is-pinned/)
  await expect(page.getByRole('status')).toHaveText(`Unpinned ${LABELS[PI]}.`)

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
  await expect(node(page, `Pi/${PI}`)).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/browse/Pi')
  await page.keyboard.press('p')
  await expect(node(page, 'Pi')).toHaveClass(/is-pinned/)
  await page.keyboard.press('p')
  await expect(node(page, 'Pi')).not.toHaveClass(/is-pinned/)

  // Tab order follows the outline: Pi body, Pi toggle, then each location body and toggle, then Claude…
  await page.keyboard.press('Tab')
  await expect(collapseButton(page, 'Pi')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, `Pi/${PI}`)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(expandButton(page, LABELS[PI])).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, `Pi/${PI_PACKAGE}`)).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, `Pi/${PI_MISSING}`)).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(nodeBody(page, 'Claude')).toBeFocused()

  // Enter on a location selects it; → expands it, then its folder.
  await nodeBody(page, `Pi/${PI}`).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await page.keyboard.press('ArrowRight')
  await expect(node(page, `Pi/${PI}/skills`)).toBeVisible()
  await nodeBody(page, `Pi/${PI}/skills`).focus()
  await page.keyboard.press('ArrowRight')
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page).toHaveURL(browseUrl('Pi', PI, 'skills'))
  await page.keyboard.press('ArrowLeft')
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toHaveCount(0)
  // Toggles are keyboard operable too.
  await collapseButton(page, 'Pi').focus()
  await page.keyboard.press('Enter')
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Claude'])
  await expect(page).toHaveURL('/browse/Pi')
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

test('outline mode replaces the graph and shares selection, expansion, breadcrumbs, unavailable state and refresh', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await expandButton(page, LABELS[PI]).click()
  await page.getByRole('button', { name: 'Outline' }).click()
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-pressed', 'true')
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await expect(outline.locator(`[data-node-id="Pi/${PI}/skills"]`)).toBeVisible()
  await expect(outline.locator(`[data-node-id="Claude/${CLAUDE}"]`)).toHaveCount(0)
  await expect(outline.locator(`[data-node-id="Pi/${PI}/skills/review.md"]`)).toHaveCount(0)
  await expect(outline.locator(`[data-node-id="Pi/${PI_MISSING}"]`)).toContainText('Unavailable')
  await expect(outline.getByRole('button', { name: new RegExp(`^${LABELS[PI_MISSING]}\\s*, location, unavailable$`) })).toBeVisible()
  await outline.getByRole('button', { name: `Expand ${LABELS[PI_MISSING]}` }).click()
  await expect(outline.locator(`[data-node-id="Pi/${PI_MISSING}"] .outline-empty`)).toContainText('does not exist')

  await outline.getByRole('button', { name: 'Expand skills' }).click()
  await expect(outline.locator(`[data-node-id="Pi/${PI}/skills/review.md"]`)).toContainText('review.md')
  await expect(outline.locator(`[data-node-id="Pi/${PI}/skills/review.md"]`)).toContainText('Markdown file')
  await outline.getByRole('button', { name: /^skills\s*, folder$/ }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, 'skills'))
  await expect(currentCrumb(page)).toHaveText('skills')
  await expect(outline.getByRole('button', { name: /^skills\s*, folder$/ })).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeDisabled()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('status')).toContainText('Refreshed')

  // Back to the graph: the same expansion and selection are shown.
  await page.getByRole('button', { name: 'Outline' }).click()
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toBeVisible()
  await expect(node(page, `Pi/${PI}/skills`)).toHaveClass(/is-selected/)
})

test('zoom, fit and empty-location display', async ({ page }) => {
  await openGraph(page)
  const initial = await viewTransform(page)
  await page.getByRole('button', { name: 'Zoom in' }).click()
  expect((await viewTransform(page)).k).toBeGreaterThan(initial.k)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  expect((await viewTransform(page)).k).toBeLessThan(initial.k)
  await page.getByRole('button', { name: 'Fit' }).click()
  expect(Math.abs((await viewTransform(page)).k - initial.k)).toBeLessThan(0.001)

  await page.route('**/api/entries', route => route.fulfill({ json: { locations: SEEDED_LOCATIONS.map(location => ({ ...location, error: location.status === 'unavailable' ? 'The configured folder does not exist.' : null })), entries: [{ source: 'Claude', locationId: CLAUDE, path: 'nothing-here', kind: 'directory' }] } }))
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expandLocation(page, 'Pi', PI)
  await expect(page.getByRole('button', { name: `${LABELS[PI]}, location, This folder is empty.` })).toBeVisible()
  await expect(node(page, `Pi/${PI}`).locator('.empty-tag')).toHaveText('empty')
  await nodeBody(page, `Pi/${PI}`).click()
  await expect(folderInfo(page)).toHaveText('This folder is empty.')
  await expandLocation(page, 'Claude', CLAUDE)
  await expect(node(page, `Claude/${CLAUDE}/nothing-here`)).toBeVisible()
  await nodeBody(page, `Claude/${CLAUDE}/nothing-here`).click()
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
        await route.fulfill({ status: 500, json: { error: 'Unable to list the configured locations. Refresh to retry.' } })
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
  await expect(page.getByText('Loading the configured Pi and Claude locations…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  release()
  await expect(page.getByRole('alert')).toContainText('Unable to list the configured locations')
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  mode = 'network-failure'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('alert')).toContainText('The API could not be reached')
  mode = 'ok'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(node(page, 'Claude')).toBeVisible()
})

test('refresh keeps the previous graph and warns when the API fails', async ({ page }) => {
  await openGraph(page, browseUrl('Pi', PI, 'skills'))
  await page.route('**/api/entries', route => route.fulfill({ status: 500, json: { error: 'Unable to list the configured locations. Refresh to retry.' } }))
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('alert')).toContainText('may be outdated')
  await expect(page.getByRole('alert')).toContainText('Unable to list the configured locations')
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toBeVisible()
  await expect(currentCrumb(page)).toHaveText('skills')
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  await page.unroute('**/api/entries')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('narrow screens keep controls reachable without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await openGraph(page, browseUrl('Claude', CLAUDE, 'subagents'))
  for (const name of ['Refresh', 'Zoom in', 'Zoom out', 'Fit', 'Reset', 'Outline']) {
    await expect(page.getByRole('button', { name })).toBeInViewport()
  }
  const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toBeInViewport()
  await expandLocation(page, 'Pi', PI)
  await expect(node(page, `Pi/${PI}/skills`)).toBeVisible()
})
