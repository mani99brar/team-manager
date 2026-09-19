import { test, expect } from '@playwright/test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentCrumb, expandButton, folderInfo, node, nodeBody, openGraph, waitForApi } from './helpers.ts'

/**
 * These tests add uniquely named scratch artifacts under fixtures/ and remove them again in afterEach,
 * even when an assertion fails. Committed sample files are never touched.
 */
const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))
const created: string[] = []

async function scratchDirectory(source: 'pi' | 'claude', name: string) {
  const path = join(fixtureRoot, source, name)
  created.push(path)
  await mkdir(path, { recursive: true })
  return path
}

test.beforeEach(async ({ request }) => { await waitForApi(request) })

test.afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
})

test('refresh adds and removes entries, handles awkward names and only shows children of expanded parents', async ({ page }) => {
  await openGraph(page)
  await nodeBody(page, 'Claude').click()

  const name = `scratch-${randomUUID().slice(0, 8)} a#b?c 100%`
  const directory = await scratchDirectory('claude', name)
  await mkdir(join(directory, 'nested', 'deeper'), { recursive: true })
  await writeFile(join(directory, 'nested', 'deeper', 'NOTE.MD'), '# hidden contents are never read')
  await writeFile(join(directory, 'ignored.txt'), 'not markdown')
  await writeFile(join(directory, 'visible.md'), '')
  await symlink(join(fixtureRoot, 'claude', 'workflow.md'), join(directory, 'linked.md'))
  await mkdir(join(directory, 'empty-folder'))

  // Nothing appears until Refresh is pressed; after that, only when the parent is expanded.
  await expect(node(page, `Claude/${name}`)).toHaveCount(0)
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('status')).toContainText('Refreshed: 6 folders and 7 Markdown files.')
  await expect(node(page, `Claude/${name}`)).toHaveCount(0)
  await expect(folderInfo(page)).toHaveText('2 folders, 2 Markdown files')
  await expandButton(page, 'Claude').click()
  await expect(node(page, `Claude/${name}`)).toBeVisible()

  await expandButton(page, name).click()
  await expect(node(page, `Claude/${name}/nested`)).toBeVisible()
  await expect(node(page, `Claude/${name}/empty-folder`)).toBeVisible()
  await expect(node(page, `Claude/${name}/visible.md`)).toBeVisible()
  await expect(node(page, `Claude/${name}/ignored.txt`)).toHaveCount(0)
  await expect(node(page, `Claude/${name}/linked.md`)).toHaveCount(0)

  // Awkward names survive the URL, reloads and history.
  await nodeBody(page, `Claude/${name}`).click()
  const encoded = `/Claude/${encodeURIComponent(name)}`
  await expect(page).toHaveURL(encoded)
  await expect(currentCrumb(page)).toHaveText(name)
  await expect(folderInfo(page)).toHaveText('2 folders, 1 Markdown file')
  await page.reload()
  await expect(currentCrumb(page)).toHaveText(name)
  await expect(node(page, `Claude/${name}/visible.md`)).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/Claude')
  await page.goForward()
  await expect(page).toHaveURL(encoded)

  // Deep paths: the breadcrumb collapses the middle behind an expandable control.
  await expandButton(page, 'nested').click()
  await nodeBody(page, `Claude/${name}/nested/deeper`).click()
  await expect(page).toHaveURL(`${encoded}/nested/deeper`)
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(breadcrumb.getByRole('link', { name: 'Claude' })).toHaveCount(0)
  await breadcrumb.getByRole('button', { name: /hidden breadcrumb/ }).click()
  await expect(breadcrumb.getByRole('link', { name: 'Claude' })).toBeVisible()
  await expect(breadcrumb.getByRole('link', { name: name })).toBeVisible()
  // Selection and expansion are separate actions: the uppercase .MD file only appears once deeper is expanded.
  await expect(node(page, `Claude/${name}/nested/deeper/NOTE.MD`)).toHaveCount(0)
  await expandButton(page, 'deeper').click()
  await expect(node(page, `Claude/${name}/nested/deeper/NOTE.MD`)).toBeVisible()

  // Removing the folder on disk: refresh shows the missing-folder state and drops the nodes.
  await rm(directory, { recursive: true, force: true })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByRole('alert')).toContainText('was not found in Claude')
  await expect(node(page, `Claude/${name}`)).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('The selected folder no longer exists.')
  await page.getByRole('link', { name: 'Go to the Claude root' }).click()
  await expect(page).toHaveURL('/Claude')
  await expect(folderInfo(page)).toHaveText('1 folder, 2 Markdown files')
})

test('a scratch tree with several hundred files loads and expands without visible delay', async ({ page }) => {
  const name = `scratch-large-${randomUUID().slice(0, 8)}`
  const directory = await scratchDirectory('pi', name)
  const writes: Promise<void>[] = []
  for (let folder = 0; folder < 5; folder += 1) {
    const sub = join(directory, `part-${folder}`)
    await mkdir(sub)
    for (let file = 0; file < 60; file += 1) writes.push(writeFile(join(sub, `note-${String(file).padStart(3, '0')}.md`), ''))
  }
  for (let file = 0; file < 40; file += 1) writes.push(writeFile(join(directory, `top-${String(file).padStart(3, '0')}.md`), ''))
  await Promise.all(writes)

  const started = Date.now()
  await openGraph(page, `/Pi/${name}`)
  await expect(node(page, `Pi/${name}/top-039.md`)).toBeVisible()
  expect(Date.now() - started).toBeLessThan(5_000)

  const expandStart = Date.now()
  for (let folder = 0; folder < 5; folder += 1) await expandButton(page, `part-${folder}`).click()
  await expect(node(page, `Pi/${name}/part-4/note-059.md`)).toBeVisible()
  await expect(page.locator('.graph-canvas .node-file')).toHaveCount(341)
  expect(Date.now() - expandStart).toBeLessThan(8_000)

  // The canvas stays navigable and collapse/reset remain available.
  await page.getByRole('button', { name: 'Fit' }).click()
  await page.getByRole('button', { name: 'Zoom out' }).click()
  await page.getByRole('button', { name: `Collapse ${name}` }).click()
  await expect(page.locator('.graph-canvas .node-file')).toHaveCount(1)
  await page.getByRole('button', { name: 'Reset' }).click()
  await expect(page).toHaveURL('/')
})
