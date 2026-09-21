import { test, expect, type Page, type Route } from '@playwright/test'
import {
  CLAUDE,
  CLAUDE_PLUGIN,
  LABELS,
  PI,
  PI_MISSING,
  PI_PACKAGE,
  browseUrl,
  collapseButton,
  currentCrumb,
  dragNode,
  expandButton,
  expandLocation,
  fileUrl,
  fit,
  node,
  nodeBody,
  openGraph,
  visibleNodeIds,
  viewTransform,
  waitForApi,
} from './helpers.ts'

test.beforeEach(async ({ request }) => { await waitForApi(request) })

function documentView(page: Page) {
  return page.getByTestId('document-view')
}

function documentHeading(page: Page) {
  return documentView(page).locator('header').getByRole('heading', { level: 2 })
}

function backToFolder(page: Page) {
  return page.getByRole('button', { name: 'Back to folder' })
}

function breadcrumbLinks(page: Page) {
  return page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link')
}

async function expectDocument(page: Page, source: 'Pi' | 'Claude', locationId: string, path: string, text: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  await expect(page).toHaveURL(fileUrl(source, locationId, path))
  await expect(documentHeading(page)).toHaveText(name)
  await expect(page.getByTestId('document-meta')).toContainText(source)
  await expect(page.getByTestId('document-location')).toHaveText(LABELS[locationId])
  await expect(page.getByTestId('document-meta')).toContainText(path)
  await expect(page.getByRole('tabpanel')).toContainText(text)
  await expect(currentCrumb(page)).toHaveText(name)
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Directory outline' })).toHaveCount(0)
}

test('clicking a file node in the graph opens the document; Back to folder restores the graph context', async ({ page }) => {
  await openGraph(page)
  await expandLocation(page, 'Pi', PI)
  await expandButton(page, 'skills').click()
  await fit(page)
  await dragNode(page, `Pi/${PI}/workflow.md`, 90, 60)
  await expect(node(page, `Pi/${PI}/workflow.md`)).toHaveClass(/is-pinned/)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  const viewBefore = await viewTransform(page)
  const idsBefore = await visibleNodeIds(page)

  // No document is fetched until a file is activated.
  const fileRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/file')) fileRequests.push(request.url()) })
  await page.getByRole('button', { name: 'review.md, Markdown file', exact: true }).click()
  await expectDocument(page, 'Pi', PI, 'skills/review.md', 'Sample review skill')
  expect(fileRequests).toHaveLength(1)
  expect(fileRequests[0]).toContain(`/api/file?source=Pi&locationId=${PI}&path=skills%2Freview.md`)
  await expect(documentHeading(page)).toBeFocused()
  await expect(page.getByRole('status')).toContainText('Loaded review.md')

  // Breadcrumbs: Home, Pi, the location and skills are links; the filename is the current, non-link item.
  await expect(breadcrumbLinks(page)).toHaveText(['Home', 'Pi', LABELS[PI], 'skills'])
  await expect(currentCrumb(page)).not.toHaveAttribute('href', /.*/)
  // The graph toolbar is not part of the document view.
  await expect(page.getByRole('button', { name: 'Fit' })).toHaveCount(0)

  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(documentView(page)).toHaveCount(0)
  expect(await visibleNodeIds(page)).toEqual(idsBefore)
  await expect(node(page, `Pi/${PI}/workflow.md`)).toHaveClass(/is-pinned/)
  const viewAfter = await viewTransform(page)
  expect(viewAfter).toEqual(viewBefore)
  await expect(nodeBody(page, `Pi/${PI}/skills/review.md`)).toBeFocused()
  await expect(currentCrumb(page)).toHaveText('Home')
})

test('opening from a selected location returns to that location, and duplicate names stay distinct across sources and locations', async ({ page }) => {
  // A location link expands the location, so its files are already visible.
  await openGraph(page, browseUrl('Claude', CLAUDE))
  await page.getByRole('button', { name: 'workflow.md, Markdown file', exact: true }).click()
  await expectDocument(page, 'Claude', CLAUDE, 'workflow.md', 'Sample Claude workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Sample Pi workflow')
  await expect(breadcrumbLinks(page)).toHaveText(['Home', 'Claude', LABELS[CLAUDE]])
  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Claude', CLAUDE))
  await expect(currentCrumb(page)).toHaveText(LABELS[CLAUDE])
  await expect(node(page, `Claude/${CLAUDE}`)).toHaveClass(/is-selected/)
  await expect(nodeBody(page, `Claude/${CLAUDE}/workflow.md`)).toBeFocused()

  await expandLocation(page, 'Pi', PI)
  await page.getByRole('button', { name: 'workflow.md, Markdown file', exact: true }).nth(0).click()
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Sample Claude workflow')

  // The same relative path in two locations of two sources.
  await backToFolder(page).click()
  await expandLocation(page, 'Pi', PI_PACKAGE)
  await expandButton(page, 'review').click()
  await fit(page)
  await nodeBody(page, `Pi/${PI_PACKAGE}/review/SKILL.md`).click()
  await expectDocument(page, 'Pi', PI_PACKAGE, 'review/SKILL.md', 'Package review skill')
  await backToFolder(page).click()
  await expandLocation(page, 'Claude', CLAUDE_PLUGIN)
  // Pi's review folder is still expanded, so the only remaining "Expand review" control is the plugin's.
  await node(page, `Claude/${CLAUDE_PLUGIN}/review`).locator('.node-toggle').click()
  await fit(page)
  await nodeBody(page, `Claude/${CLAUDE_PLUGIN}/review/SKILL.md`).click()
  await expectDocument(page, 'Claude', CLAUDE_PLUGIN, 'review/SKILL.md', 'Plugin review skill')
  await expect(page.getByRole('tabpanel')).not.toContainText('Package review skill')
})

test('outline mode: files are buttons that open the document; return keeps outline mode, expansion, scroll and focus', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 420 })
  await openGraph(page)
  await page.getByRole('button', { name: 'Outline' }).click()
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await outline.getByRole('button', { name: 'Expand Pi' }).click()
  await outline.getByRole('button', { name: `Expand ${LABELS[PI]}` }).click()
  await outline.getByRole('button', { name: 'Expand skills' }).click()
  await outline.getByRole('button', { name: 'Expand Claude' }).click()
  await outline.getByRole('button', { name: `Expand ${LABELS[CLAUDE]}` }).click()
  await outline.getByRole('button', { name: 'Expand subagents' }).click()
  const fileButton = outline.getByRole('button', { name: /^implementer\.md\s*, Markdown file$/ })
  await expect(fileButton).toBeVisible()
  // Scroll the outline so the position can be restored later.
  await outline.evaluate(element => { element.scrollTop = element.scrollHeight })
  const scrollBefore = await outline.evaluate(element => element.scrollTop)
  expect(scrollBefore).toBeGreaterThan(0)

  await fileButton.click()
  await expectDocument(page, 'Claude', CLAUDE, 'subagents/implementer.md', 'Sample implementer')
  await expect(page.getByRole('tabpanel')).toContainText('Complete one bounded coding task.')

  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await expect(outline).toBeVisible()
  await expect(page.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-pressed', 'true')
  await expect(outline.locator(`[data-node-id="Pi/${PI}/skills/review.md"]`)).toBeVisible()
  await expect(fileButton).toBeFocused()
  expect(await outline.evaluate(element => element.scrollTop)).toBe(scrollBefore)
})

test('keyboard: Enter on a graph file node or an outline file button opens the document; Back to folder is keyboard operable', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Pi').focus()
  await page.keyboard.press('ArrowRight')
  await nodeBody(page, `Pi/${PI}`).focus()
  await page.keyboard.press('ArrowRight')
  await nodeBody(page, `Pi/${PI}/workflow.md`).focus()
  await page.keyboard.press('Enter')
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await expect(documentHeading(page)).toBeFocused()
  await backToFolder(page).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/')
  await expect(nodeBody(page, `Pi/${PI}/workflow.md`)).toBeFocused()

  await page.getByRole('button', { name: 'Outline' }).click()
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await outline.getByRole('button', { name: 'Expand skills' }).focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(outline.getByRole('button', { name: /^workflow\.md\s*, Markdown file$/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
})

test('dragging a file node pins it without opening the document', async ({ page }) => {
  await openGraph(page)
  await expandLocation(page, 'Pi', PI)
  await dragNode(page, `Pi/${PI}/workflow.md`, 120, 80)
  await expect(node(page, `Pi/${PI}/workflow.md`)).toHaveClass(/is-pinned/)
  await expect(page).toHaveURL('/')
  await expect(documentView(page)).toHaveCount(0)
  await expect(page.locator('.graph-canvas')).toBeVisible()
  // A plain click afterwards still opens it.
  await nodeBody(page, `Pi/${PI}/workflow.md`).click()
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
})

test('direct links and reloads open the document without prior selection; Back to folder falls back to the containing folder', async ({ page }) => {
  await page.goto('about:blank')
  await page.goto(fileUrl('Claude', CLAUDE, 'subagents/implementer.md'))
  await expectDocument(page, 'Claude', CLAUDE, 'subagents/implementer.md', 'Sample implementer')
  await expect(breadcrumbLinks(page)).toHaveText(['Home', 'Claude', LABELS[CLAUDE], 'subagents'])
  await page.reload()
  await expectDocument(page, 'Claude', CLAUDE, 'subagents/implementer.md', 'Sample implementer')

  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Claude', CLAUDE, 'subagents'))
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(currentCrumb(page)).toHaveText('subagents')
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toHaveClass(/is-selected/)
  await expect(node(page, `Claude/${CLAUDE}/subagents/implementer.md`)).toBeVisible()
  await expect(collapseButton(page, 'subagents')).toBeVisible()
  // Browser Back returns to the document, not to about:blank.
  await page.goBack()
  await expectDocument(page, 'Claude', CLAUDE, 'subagents/implementer.md', 'Sample implementer')
})

test('Back/Forward moves between documents and browsing without mixing identities', async ({ page }) => {
  await openGraph(page)
  await expandLocation(page, 'Pi', PI)
  await expandLocation(page, 'Claude', CLAUDE)
  await nodeBody(page, `Pi/${PI}/workflow.md`).click()
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await nodeBody(page, `Claude/${CLAUDE}/workflow.md`).click()
  await expectDocument(page, 'Claude', CLAUDE, 'workflow.md', 'Sample Claude workflow')

  await page.goBack()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  expect(await visibleNodeIds(page)).toEqual([
    'Pi', `Pi/${PI}`, `Pi/${PI}/skills`, `Pi/${PI}/workflow.md`, `Pi/${PI_PACKAGE}`, `Pi/${PI_MISSING}`,
    'Claude', `Claude/${CLAUDE}`, `Claude/${CLAUDE}/subagents`, `Claude/${CLAUDE}/empty.md`, `Claude/${CLAUDE}/workflow.md`, `Claude/${CLAUDE_PLUGIN}`,
  ])
  await page.goBack()
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Claude')
  await page.goBack()
  await expect(page).toHaveURL('/')
  await expect(documentView(page)).toHaveCount(0)
  await page.goForward()
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await page.goForward()
  await expect(page).toHaveURL('/')
  await page.goForward()
  await expectDocument(page, 'Claude', CLAUDE, 'workflow.md', 'Sample Claude workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Pi workflow')
})

test('stale responses never replace a newer selection or reopen a document after navigating away', async ({ page }) => {
  const pending: Route[] = []
  await page.route('**/api/file?*', async route => {
    if (new URL(route.request().url()).searchParams.get('path') === 'skills/review.md') pending.push(route)
    else await route.continue()
  })
  const release = async (status: number) => {
    for (const route of pending.splice(0)) {
      try {
        if (status === 200) {
          await route.fulfill({ status, json: { source: 'Pi', locationId: PI, path: 'skills/review.md', content: '# STALE CONTENT\n', hash: 'x' } })
        } else {
          await route.fulfill({ status, json: { error: 'Simulated failure.' } })
        }
      } catch {
        // The page cancelled the request, which is also acceptable.
      }
    }
  }

  await openGraph(page)
  await expandLocation(page, 'Pi', PI)
  await expandButton(page, 'skills').click()
  await fit(page)
  // 1. Open the slow document, go back while it loads, open another document, then let the slow error arrive.
  await nodeBody(page, `Pi/${PI}/skills/review.md`).click()
  await expect(page).toHaveURL(fileUrl('Pi', PI, 'skills/review.md'))
  await expect(page.getByRole('tabpanel')).toContainText('Loading review.md')
  await backToFolder(page).click()
  await nodeBody(page, `Pi/${PI}/workflow.md`).click()
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await release(500)
  await expectDocument(page, 'Pi', PI, 'workflow.md', 'Sample Pi workflow')
  await expect(page.getByRole('alert')).toHaveCount(0)

  // 2. Open the slow document again, return to browsing, then let a stale success arrive.
  await backToFolder(page).click()
  await nodeBody(page, `Pi/${PI}/skills/review.md`).click()
  await expect(page.getByRole('tabpanel')).toContainText('Loading review.md')
  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await release(200)
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(documentView(page)).toHaveCount(0)
  await expect(page.getByText('STALE CONTENT')).toHaveCount(0)
  await expect(page).toHaveURL('/')

  // 3. Once released promptly, the same document loads normally.
  await page.unroute('**/api/file?*')
  await nodeBody(page, `Pi/${PI}/skills/review.md`).click()
  await expectDocument(page, 'Pi', PI, 'skills/review.md', 'Sample review skill')
})
