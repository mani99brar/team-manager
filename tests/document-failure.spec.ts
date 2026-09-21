import { test, expect, type Page, type Route } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CLAUDE, LABELS, PI, browseUrl, currentCrumb, expandButton, expandLocation, fileUrl, fit, node, nodeBody, openGraph, roots, visibleNodeIds, waitForApi } from './helpers.ts'

const created: string[] = []

async function scratchFolder(root: string, name: string) {
  const directory = join(root, name)
  created.push(directory)
  await mkdir(directory, { recursive: true })
  return directory
}

test.beforeEach(async ({ request }) => { await waitForApi(request) })

test.afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
})

function documentView(page: Page) {
  return page.getByTestId('document-view')
}

function heading(page: Page) {
  return documentView(page).locator('header').getByRole('heading', { level: 2 })
}

function backToFolder(page: Page) {
  return page.getByRole('button', { name: 'Back to folder' })
}

test('missing files explain themselves; a deleted file fails on reopen without losing the browsing context', async ({ page }) => {
  await page.goto(fileUrl('Pi', PI, 'does-not-exist.md'))
  await expect(heading(page)).toHaveText('does-not-exist.md')
  await expect(page.getByRole('alert')).toContainText('does-not-exist.md was not found in Pi or is unavailable')
  await expect(page.getByRole('status')).toContainText('does-not-exist.md was not found.')
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(currentCrumb(page)).toHaveText(LABELS[PI])

  // A file that exists when opened but is deleted later.
  const folder = `scratch-missing-${randomUUID().slice(0, 8)}`
  const directory = await scratchFolder(roots.claudePersonal, folder)
  await writeFile(join(directory, 'gone.md'), '# Still here\n')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('status')).toContainText('Refreshed')
  await expandLocation(page, 'Claude', CLAUDE)
  await expandButton(page, folder).click()
  await fit(page)
  const idsBefore = await visibleNodeIds(page)
  await nodeBody(page, `Claude/${CLAUDE}/${folder}/gone.md`).click()
  await expect(page.getByRole('tabpanel')).toContainText('Still here')

  await rm(join(directory, 'gone.md'))
  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  const pending: Route[] = []
  await page.route('**/api/file?*', route => { pending.push(route) })
  await nodeBody(page, `Claude/${CLAUDE}/${folder}/gone.md`).click()
  await expect(documentView(page)).toHaveAttribute('aria-busy', 'true')
  await expect(documentView(page)).not.toHaveAttribute('data-hash')
  await expect(page.getByRole('tabpanel')).not.toContainText('Still here')
  await expect.poll(() => pending.length).toBe(1)
  await pending[0].continue()
  await expect(page).toHaveURL(fileUrl('Claude', CLAUDE, `${folder}/gone.md`))
  await expect(page.getByRole('alert')).toContainText('gone.md was not found in Claude or is unavailable')
  await expect(page.getByRole('tabpanel')).not.toContainText('Still here')
  // The failure did not destroy the saved browsing context.
  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  expect(await visibleNodeIds(page)).toEqual(idsBefore)
  await expect(nodeBody(page, `Claude/${CLAUDE}/${folder}/gone.md`)).toBeFocused()
})

test('invalid links: malformed encoding, unknown sources and server-rejected paths', async ({ page }) => {
  await page.goto(`/file/Pi/${PI}/%E0%A4%A`)
  await expect(page.getByRole('alert')).toContainText('This link is invalid')
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('This link is invalid')
  await expect(documentView(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Go to the Pi root' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Go to the Claude root' })).toBeVisible()
  await page.getByRole('alert').getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.goto(`/file/Nope/${PI}/review.md`)
  await expect(page.getByRole('alert')).toContainText('Source “Nope” does not exist')
  await expect(documentView(page)).toHaveCount(0)

  // Well-formed in the URL but rejected by the API validator.
  await page.goto(`/file/Pi/${PI}/a%5Cb.md`)
  await expect(heading(page)).toHaveText('a\\b.md')
  await expect(page.getByRole('alert')).toContainText('The link to a\\b.md is invalid')
  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
})

test('API and network failures offer Retry and Back to folder; a successful retry replaces the error with the document and hash', async ({ page, request }) => {
  let mode: 'server-error' | 'network-error' | 'ok' = 'server-error'
  await page.route('**/api/file?*', async route => {
    try {
      if (mode === 'server-error') await route.fulfill({ status: 500, json: { error: 'The file could not be read. Check that it is readable, then retry.' } })
      else if (mode === 'network-error') await route.abort()
      else await route.continue()
    } catch {
      // The page may have cancelled the request.
    }
  })
  await openGraph(page)
  await expandLocation(page, 'Pi', PI)
  await nodeBody(page, `Pi/${PI}/workflow.md`).click()
  await expect(page.getByRole('alert')).toContainText('workflow.md could not be loaded. The file could not be read.')
  await expect(page.getByRole('status')).toContainText('Loading workflow.md failed.')
  await expect(page.getByRole('tabpanel')).not.toContainText('Sample Pi workflow')

  mode = 'network-error'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('alert')).toContainText('The API could not be reached')

  mode = 'ok'
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
  await expect(page.getByRole('alert')).toHaveCount(0)
  const expected = await (await request.get(`/api/file?source=Pi&locationId=${PI}&path=workflow.md`)).json()
  await expect(documentView(page)).toHaveAttribute('data-hash', expected.hash)
  await expect(page.getByRole('status')).toContainText('Loaded workflow.md.')

  // Back to folder from the error state also works and restores the graph.
  mode = 'server-error'
  await backToFolder(page).click()
  await fit(page)
  await nodeBody(page, `Pi/${PI}/skills`).click()
  await expandButton(page, 'skills').click()
  await fit(page)
  await nodeBody(page, `Pi/${PI}/skills/review.md`).click()
  await expect(page.getByRole('alert')).toContainText('review.md could not be loaded')
  await backToFolder(page).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, 'skills'))
  await expect(node(page, `Pi/${PI}/skills/review.md`)).toBeVisible()
  await expect(nodeBody(page, `Pi/${PI}/skills/review.md`)).toBeFocused()
})

test('loading is announced and navigating away while loading returns to browsing cleanly', async ({ page }) => {
  const pending: Route[] = []
  await page.route('**/api/file?*', route => { pending.push(route) })
  await openGraph(page, browseUrl('Claude', CLAUDE))
  await nodeBody(page, `Claude/${CLAUDE}/empty.md`).click()
  await expect(page.getByRole('status')).toContainText('Loading empty.md.')
  await expect(page.getByRole('tabpanel')).toContainText('Loading empty.md')
  await expect(documentView(page)).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByRole('alert')).toHaveCount(0)

  // Breadcrumb navigation during loading returns to browsing.
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: LABELS[CLAUDE] }).click()
  await expect(page).toHaveURL(browseUrl('Claude', CLAUDE))
  await expect(documentView(page)).toHaveCount(0)
  await expect(page.locator('.graph-canvas')).toBeVisible()
  for (const route of pending.splice(0)) {
    try { await route.fulfill({ status: 200, json: { source: 'Claude', locationId: CLAUDE, path: 'empty.md', content: 'late', hash: 'x' } }) } catch { /* cancelled */ }
  }
  await expect(documentView(page)).toHaveCount(0)
  await expect(page).toHaveURL(browseUrl('Claude', CLAUDE))

  // Once responses flow again, opening works and announces completion.
  await page.unroute('**/api/file?*')
  await nodeBody(page, `Claude/${CLAUDE}/empty.md`).click()
  await expect(page.getByRole('tabpanel')).toContainText('This file is empty')
  await expect(page.getByRole('status')).toContainText('Loaded empty.md.')
  await expect(documentView(page)).toHaveAttribute('aria-busy', 'false')
})

test('a Markdown file over 100 KB stays responsive: render, tab switches and Back to folder', async ({ page }) => {
  const folder = `scratch-large-doc-${randomUUID().slice(0, 8)}`
  const directory = await scratchFolder(roots.piPersonal, folder)
  const sections: string[] = ['# Large document', '']
  for (let i = 0; i < 200; i += 1) {
    sections.push(
      `## Section ${i}`,
      '',
      `Paragraph ${i} with **bold**, _italic_, \`code\` and a [link](https://example.com/${i}). `.repeat(4),
      '',
      `- item ${i}.1`,
      `- item ${i}.2`,
      `  - nested ${i}.2.1`,
      '- [ ] task ${i}',
      '',
      '```ts',
      `export function section${i}(value: number): number {`,
      `  return value * ${i} + 1`,
      '}',
      '```',
      '',
      '| Key | Value | Note |',
      '| --- | ---: | --- |',
      `| alpha-${i} | ${i * 10} | first row |`,
      `| beta-${i} | ${i * 20} | second row |`,
      '',
    )
  }
  const content = sections.join('\n')
  expect(Buffer.byteLength(content)).toBeGreaterThan(100 * 1024)
  await writeFile(join(directory, 'large.md'), content)

  await openGraph(page, browseUrl('Pi', PI, folder))
  await expect(node(page, `Pi/${PI}/${folder}/large.md`)).toBeVisible()
  const responded = page.waitForResponse(response => response.url().includes('/api/file') && response.status() === 200)
  await nodeBody(page, `Pi/${PI}/${folder}/large.md`).click()
  await responded
  const respondedAt = Date.now()
  await expect(page.getByRole('tabpanel').getByRole('heading', { level: 2, name: 'Section 159' })).toBeAttached()
  await expect(page.getByRole('tabpanel').getByRole('heading', { level: 1, name: 'Large document' })).toBeVisible()
  expect(Date.now() - respondedAt).toBeLessThan(5_000)

  const toSource = Date.now()
  await page.getByRole('tab', { name: 'Source' }).click()
  await expect(page.getByTestId('document-source')).toBeVisible()
  expect(await page.getByTestId('document-source').evaluate(element => element.textContent?.length)).toBe(content.length)
  expect(Date.now() - toSource).toBeLessThan(2_000)

  const toRendered = Date.now()
  await page.getByRole('tab', { name: 'Rendered' }).click()
  await expect(page.getByRole('tabpanel').getByRole('heading', { level: 1, name: 'Large document' })).toBeVisible()
  expect(Date.now() - toRendered).toBeLessThan(2_000)

  const toFolder = Date.now()
  await backToFolder(page).click()
  await expect(page.locator('.graph-canvas')).toBeVisible()
  await expect(nodeBody(page, `Pi/${PI}/${folder}/large.md`)).toBeFocused()
  expect(Date.now() - toFolder).toBeLessThan(2_000)
})
