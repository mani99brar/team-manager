import { test, expect } from '@playwright/test'
import { expandButton, collapseButton, node, nodeBody, openGraph, visibleNodeIds, viewTransform, dragNode, waitForApi } from './helpers.ts'

test.beforeEach(async ({ request }) => { await waitForApi(request) })

for (const initial of ['ready', 'error'] as const) {
  test(`same file reopened after ${initial} starts fresh with no old content or hash`, async ({ page }) => {
    if (initial === 'error') await page.route('**/api/file?*', route => route.fulfill({ status: 500, json: { error: 'old error' } }))
    await openGraph(page, '/Pi')
    await nodeBody(page, 'Pi/workflow.md').click()
    if (initial === 'ready') await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
    else await expect(page.getByRole('alert')).toContainText('old error')
    await page.getByRole('button', { name: 'Back to folder' }).click()
    await page.unroute('**/api/file?*')
    await page.route('**/api/file?*', () => { /* held until page closes */ })
    await nodeBody(page, 'Pi/workflow.md').click()
    await expect(page.getByTestId('document-view')).toHaveAttribute('aria-busy', 'true')
    await expect(page.getByTestId('document-view')).not.toHaveAttribute('data-hash')
    await expect(page.getByRole('tabpanel')).toContainText('Loading workflow.md')
    await expect(page.getByRole('tabpanel')).not.toContainText('Sample Pi workflow')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}

for (const entry of ['direct', 'reload', 'retry'] as const) {
  test(`${entry} announces loading in the live region`, async ({ page }) => {
    if (entry === 'retry') {
      await page.route('**/api/file?*', route => route.fulfill({ status: 500, json: { error: 'try again' } }))
      await page.goto('/file/Pi/workflow.md')
      await expect(page.getByRole('alert')).toBeVisible()
      await page.unroute('**/api/file?*')
    } else if (entry === 'reload') {
      await page.goto('/file/Pi/workflow.md')
      await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
    }
    await page.route('**/api/file?*', () => { /* deliberately pending */ })
    if (entry === 'retry') await page.getByRole('button', { name: 'Retry' }).click()
    else if (entry === 'reload') await page.reload()
    else await page.goto('/file/Pi/workflow.md')
    await expect(page.getByRole('status')).toHaveText('Loading workflow.md.')
    await expect(page.getByTestId('document-view')).toHaveAttribute('aria-busy', 'true')
  })
}

test('malformed direct link and reload render the invalid-link UI', async ({ page }) => {
  await page.goto('/file/Pi/%E0%A4%A')
  await expect(page.getByRole('alert')).toContainText('This link is invalid')
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('This link is invalid')
  await expect(page.getByRole('link', { name: 'Go to the Pi root' })).toBeVisible()
})

test('browser Back restores focus without reopening a collapsed selected folder or moving the viewport', async ({ page }) => {
  await openGraph(page, '/Pi/skills')
  await collapseButton(page, 'skills').click()
  await expandButton(page, 'Claude').click()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await nodeBody(page, 'Claude/workflow.md').focus()
  const view = await viewTransform(page)
  const ids = await visibleNodeIds(page)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tabpanel')).toContainText('Sample Claude workflow')
  await page.goBack()
  await expect(page).toHaveURL('/Pi/skills')
  await expect(nodeBody(page, 'Claude/workflow.md')).toBeFocused()
  expect(await visibleNodeIds(page)).toEqual(ids)
  expect(await viewTransform(page)).toEqual(view)
  await expect(expandButton(page, 'skills')).toBeVisible()
})

test('repeated document URLs keep independent origin selection, mode, expansion, positions, pins and viewport', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await expandButton(page, 'skills').click()
  await dragNode(page, 'Pi/workflow.md', 45, 30)
  await page.getByRole('button', { name: 'Zoom out' }).click()
  const ids = await visibleNodeIds(page)
  const view = await viewTransform(page)
  const positions = await page.locator('.graph-canvas .node').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-node-id'), node.getAttribute('transform')]))
  await nodeBody(page, 'Pi/workflow.md').click()
  await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await nodeBody(page, 'Pi/workflow.md').focus()
  await page.keyboard.press('p')
  await collapseButton(page, 'skills').click()
  await page.getByRole('button', { name: 'Outline' }).click()
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await outline.getByRole('button', { name: /Claude\s*, source folder/ }).click()
  await outline.locator('[data-node-id="Pi/workflow.md"] .outline-name').click()
  await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
  await page.goBack() // /Claude origin of the second opening
  await expect(outline).toBeVisible()
  await expect(outline.locator('[data-node-id="Pi/workflow.md"] .outline-name')).toBeFocused()
  await page.goBack() // browsing Home after first return
  await page.goBack() // first document opening, same URL
  await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  expect(await visibleNodeIds(page)).toEqual(ids)
  expect(await viewTransform(page)).toEqual(view)
  await expect(node(page, 'Pi/workflow.md')).toHaveClass(/is-pinned/)
  expect(await page.locator('.graph-canvas .node').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-node-id'), node.getAttribute('transform')]))).toEqual(positions)
  await expect(nodeBody(page, 'Pi/workflow.md')).toBeFocused()
})
