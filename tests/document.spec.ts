import { test, expect, type Page, type Route } from '@playwright/test'
import {
  collapseButton,
  currentCrumb,
  dragNode,
  expandButton,
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

async function expectDocument(page: Page, source: 'Pi' | 'Claude', path: string, text: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  await expect(page).toHaveURL(`/file/${source}/${path.split('/').map(encodeURIComponent).join('/')}`)
  await expect(documentHeading(page)).toHaveText(name)
  await expect(page.getByTestId('document-meta')).toContainText(source)
  await expect(page.getByTestId('document-meta')).toContainText(path)
  await expect(page.getByRole('tabpanel')).toContainText(text)
  await expect(currentCrumb(page)).toHaveText(name)
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Directory outline' })).toHaveCount(0)
}

test('clicking a file node in the graph opens the document; Back to folder restores the graph context', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await expandButton(page, 'skills').click()
  await dragNode(page, 'Pi/workflow.md', 90, 60)
  await expect(node(page, 'Pi/workflow.md')).toHaveClass(/is-pinned/)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  const viewBefore = await viewTransform(page)
  const idsBefore = await visibleNodeIds(page)

  // No document is fetched until a file is activated.
  const fileRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/file')) fileRequests.push(request.url()) })
  await page.getByRole('button', { name: 'review.md, Markdown file', exact: true }).click()
  await expectDocument(page, 'Pi', 'skills/review.md', 'Sample review skill')
  expect(fileRequests).toHaveLength(1)
  expect(fileRequests[0]).toContain('/api/file?source=Pi&path=skills%2Freview.md')
  await expect(documentHeading(page)).toBeFocused()
  await expect(page.getByRole('status')).toContainText('Loaded review.md')

  // Breadcrumbs: Home, Pi and skills are links; the filename is the current, non-link item.
  await expect(breadcrumbLinks(page)).toHaveText(['Home', 'Pi', 'skills'])
  await expect(currentCrumb(page)).not.toHaveAttribute('href', /.*/)
  // The graph toolbar is not part of the document view.
  await expect(page.getByRole('button', { name: 'Fit' })).toHaveCount(0)

  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(documentView(page)).toHaveCount(0)
  expect(await visibleNodeIds(page)).toEqual(idsBefore)
  await expect(node(page, 'Pi/workflow.md')).toHaveClass(/is-pinned/)
  const viewAfter = await viewTransform(page)
  expect(viewAfter).toEqual(viewBefore)
  await expect(nodeBody(page, 'Pi/skills/review.md')).toBeFocused()
  await expect(currentCrumb(page)).toHaveText('Home')
})

test('opening from a selected folder returns to that folder, and duplicate names stay distinct', async ({ page }) => {
  // A folder link expands the folder, so its files are already visible.
  await openGraph(page, '/Claude')
  await page.getByRole('button', { name: 'workflow.md, Markdown file', exact: true }).click()
  await expectDocument(page, 'Claude', 'workflow.md', 'Sample Claude workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Sample Pi workflow')
  await expect(breadcrumbLinks(page)).toHaveText(['Home', 'Claude'])
  await backToFolder(page).click()
  await expect(page).toHaveURL('/Claude')
  await expect(currentCrumb(page)).toHaveText('Claude')
  await expect(node(page, 'Claude')).toHaveClass(/is-selected/)
  await expect(nodeBody(page, 'Claude/workflow.md')).toBeFocused()

  await expandButton(page, 'Pi').click()
  await page.getByRole('button', { name: 'workflow.md, Markdown file', exact: true }).nth(0).click()
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Sample Claude workflow')
})

test('outline mode: files are buttons that open the document; return keeps outline mode, expansion, scroll and focus', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 420 })
  await openGraph(page)
  await page.getByRole('button', { name: 'Outline' }).click()
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await outline.getByRole('button', { name: 'Expand Pi' }).click()
  await outline.getByRole('button', { name: 'Expand skills' }).click()
  await outline.getByRole('button', { name: 'Expand Claude' }).click()
  await outline.getByRole('button', { name: 'Expand subagents' }).click()
  const fileButton = outline.getByRole('button', { name: /^implementer\.md\s*, Markdown file$/ })
  await expect(fileButton).toBeVisible()
  // Scroll the outline so the position can be restored later.
  await outline.evaluate(element => { element.scrollTop = element.scrollHeight })
  const scrollBefore = await outline.evaluate(element => element.scrollTop)
  expect(scrollBefore).toBeGreaterThan(0)

  await fileButton.click()
  await expectDocument(page, 'Claude', 'subagents/implementer.md', 'Sample implementer')
  await expect(page.getByRole('tabpanel')).toContainText('Complete one bounded coding task.')

  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await expect(outline).toBeVisible()
  await expect(page.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-pressed', 'true')
  await expect(outline.locator('[data-node-id="Pi/skills/review.md"]')).toBeVisible()
  await expect(fileButton).toBeFocused()
  expect(await outline.evaluate(element => element.scrollTop)).toBe(scrollBefore)
})

test('keyboard: Enter on a graph file node or an outline file button opens the document; Back to folder is keyboard operable', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Pi').focus()
  await page.keyboard.press('ArrowRight')
  await nodeBody(page, 'Pi/workflow.md').focus()
  await page.keyboard.press('Enter')
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await expect(documentHeading(page)).toBeFocused()
  await backToFolder(page).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL('/')
  await expect(nodeBody(page, 'Pi/workflow.md')).toBeFocused()

  await page.getByRole('button', { name: 'Outline' }).click()
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await outline.getByRole('button', { name: 'Expand skills' }).focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(outline.getByRole('button', { name: /^workflow\.md\s*, Markdown file$/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
})

test('dragging a file node pins it without opening the document', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await dragNode(page, 'Pi/workflow.md', 120, 80)
  await expect(node(page, 'Pi/workflow.md')).toHaveClass(/is-pinned/)
  await expect(page).toHaveURL('/')
  await expect(documentView(page)).toHaveCount(0)
  await expect(page.locator('.graph-canvas')).toBeVisible()
  // A plain click afterwards still opens it.
  await nodeBody(page, 'Pi/workflow.md').click()
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
})

test('direct links and reloads open the document without prior selection; Back to folder falls back to the containing folder', async ({ page }) => {
  await page.goto('about:blank')
  await page.goto('/file/Claude/subagents/implementer.md')
  await expectDocument(page, 'Claude', 'subagents/implementer.md', 'Sample implementer')
  await expect(breadcrumbLinks(page)).toHaveText(['Home', 'Claude', 'subagents'])
  await page.reload()
  await expectDocument(page, 'Claude', 'subagents/implementer.md', 'Sample implementer')

  await backToFolder(page).click()
  await expect(page).toHaveURL('/Claude/subagents')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(currentCrumb(page)).toHaveText('subagents')
  await expect(node(page, 'Claude/subagents')).toHaveClass(/is-selected/)
  await expect(node(page, 'Claude/subagents/implementer.md')).toBeVisible()
  await expect(collapseButton(page, 'subagents')).toBeVisible()
  // Browser Back returns to the document, not to about:blank.
  await page.goBack()
  await expectDocument(page, 'Claude', 'subagents/implementer.md', 'Sample implementer')
})

test('Back/Forward moves between documents and browsing without mixing identities', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await expandButton(page, 'Claude').click()
  await nodeBody(page, 'Pi/workflow.md').click()
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await backToFolder(page).click()
  await expect(page).toHaveURL('/')
  await nodeBody(page, 'Claude/workflow.md').click()
  await expectDocument(page, 'Claude', 'workflow.md', 'Sample Claude workflow')

  await page.goBack()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  expect(await visibleNodeIds(page)).toEqual(['Pi', 'Pi/skills', 'Pi/workflow.md', 'Claude', 'Claude/subagents', 'Claude/empty.md', 'Claude/workflow.md'])
  await page.goBack()
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await expect(page.getByRole('tabpanel')).not.toContainText('Claude')
  await page.goBack()
  await expect(page).toHaveURL('/')
  await expect(documentView(page)).toHaveCount(0)
  await page.goForward()
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await page.goForward()
  await expect(page).toHaveURL('/')
  await page.goForward()
  await expectDocument(page, 'Claude', 'workflow.md', 'Sample Claude workflow')
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
          await route.fulfill({ status, json: { source: 'Pi', path: 'skills/review.md', content: '# STALE CONTENT\n', hash: 'x' } })
        } else {
          await route.fulfill({ status, json: { error: 'Simulated failure.' } })
        }
      } catch {
        // The page cancelled the request, which is also acceptable.
      }
    }
  }

  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await expandButton(page, 'skills').click()
  // 1. Open the slow document, go back while it loads, open another document, then let the slow error arrive.
  await nodeBody(page, 'Pi/skills/review.md').click()
  await expect(page).toHaveURL('/file/Pi/skills/review.md')
  await expect(page.getByRole('tabpanel')).toContainText('Loading review.md')
  await backToFolder(page).click()
  await nodeBody(page, 'Pi/workflow.md').click()
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await release(500)
  await expectDocument(page, 'Pi', 'workflow.md', 'Sample Pi workflow')
  await expect(page.getByRole('alert')).toHaveCount(0)

  // 2. Open the slow document again, return to browsing, then let a stale success arrive.
  await backToFolder(page).click()
  await nodeBody(page, 'Pi/skills/review.md').click()
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
  await nodeBody(page, 'Pi/skills/review.md').click()
  await expectDocument(page, 'Pi', 'skills/review.md', 'Sample review skill')
})
