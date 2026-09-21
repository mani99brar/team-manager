import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLAUDE,
  CLAUDE_PLUGIN,
  LABELS,
  PI,
  PI_MISSING,
  PI_PACKAGE,
  browseUrl,
  currentCrumb,
  expandButton,
  expandLocation,
  fileUrl,
  fit,
  folderInfo,
  node,
  nodeBody,
  openGraph,
  roots,
  waitForApi,
} from './helpers.ts'

/**
 * Multi-location behaviour (PRD_LIVE_SKILLS Slice 3): distinct locations under each source, per-location
 * availability, explicit location choice for creation and copy, installed-file notices and legacy links.
 * Scratch artifacts are removed in afterEach, including the temporarily created pi-missing root.
 */
const created: string[] = []

test.beforeEach(async ({ request }) => { await waitForApi(request) })
test.afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scratchName(suffix = '.md') {
  return `scratch-${randomUUID().slice(0, 8)}${suffix}`
}

async function exists(path: string) {
  try { await stat(path); return true } catch { return false }
}

const dialog = (page: Page) => page.getByRole('dialog')
const outcome = (page: Page) => page.getByTestId('operation-outcome')
const editButton = (page: Page) => page.getByRole('button', { name: 'Edit', exact: true })
const editor = (page: Page) => page.locator('.cm-content')

test('the same relative path in different locations opens distinct documents whose identity names the location', async ({ page }) => {
  await page.goto(fileUrl('Pi', PI_PACKAGE, 'review/SKILL.md'))
  await expect(page.getByRole('tabpanel')).toContainText('Package review skill')
  await expect(page.getByTestId('document-meta')).toContainText('Pi')
  await expect(page.getByTestId('document-location')).toHaveText(LABELS[PI_PACKAGE])
  await expect(page.getByTestId('document-meta')).toContainText('review/SKILL.md')
  const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(breadcrumb.getByRole('link')).toHaveText(['Home', 'Pi', LABELS[PI_PACKAGE], 'review'])
  await expect(currentCrumb(page)).toHaveText('SKILL.md')

  await page.goto(fileUrl('Claude', CLAUDE_PLUGIN, 'review/SKILL.md'))
  await expect(page.getByRole('tabpanel')).toContainText('Plugin review skill')
  await expect(page.getByRole('tabpanel')).not.toContainText('Package review skill')
  await expect(page.getByTestId('document-location')).toHaveText(LABELS[CLAUDE_PLUGIN])

  // Back to folder from a direct link opens the containing folder inside the right location.
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(page).toHaveURL(browseUrl('Claude', CLAUDE_PLUGIN, 'review'))
  await expect(node(page, `Claude/${CLAUDE_PLUGIN}/review/SKILL.md`)).toBeVisible()
  await expect(node(page, `Pi/${PI_PACKAGE}/review/SKILL.md`)).toHaveCount(0)
  await expect(nodeBody(page, `Claude/${CLAUDE_PLUGIN}/review/SKILL.md`)).toBeFocused()
})

test('package and plugin files show a persistent installed-file notice; personal files do not; saving still works', async ({ page }) => {
  const name = await scratchName()
  const path = join(roots.piPackage, name)
  created.push(path)
  await writeFile(path, '# installed\n')
  await page.goto(fileUrl('Pi', PI_PACKAGE, name))
  await expect(page.getByTestId('installed-notice')).toContainText('package')
  await expect(page.getByTestId('installed-notice')).toContainText(LABELS[PI_PACKAGE])
  await expect(page.getByTestId('installed-notice')).toContainText(/overwrite/i)
  await expect(editButton(page)).toBeEnabled()
  await editButton(page).click()
  await expect(page.getByTestId('installed-notice')).toBeVisible()
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('edited')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  expect(await readFile(path, 'utf8')).toBe('# installed\nedited')

  await page.goto(fileUrl('Claude', CLAUDE_PLUGIN, 'review/SKILL.md'))
  await expect(page.getByTestId('installed-notice')).toContainText('plugin')
  await page.goto(fileUrl('Pi', PI, 'workflow.md'))
  await expect(page.getByRole('tabpanel')).toContainText('Sample Pi workflow')
  await expect(page.getByTestId('installed-notice')).toHaveCount(0)
})

test('an unavailable location is visible with its error, refuses creation, and recovers on Refresh when restored', async ({ page }) => {
  await openGraph(page)
  await expandButton(page, 'Pi').click()
  await fit(page)
  const missing = node(page, `Pi/${PI_MISSING}`)
  await expect(missing).toHaveClass(/is-unavailable/)
  await expect(missing.locator('.unavailable-tag')).toHaveText('unavailable')
  await nodeBody(page, `Pi/${PI_MISSING}`).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI_MISSING))
  await expect(currentCrumb(page)).toHaveText(LABELS[PI_MISSING])
  await expect(folderInfo(page)).toContainText('Unavailable')
  await expect(folderInfo(page)).toContainText('does not exist')
  await expect(page.getByRole('button', { name: 'New file…' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'New folder…' })).toBeDisabled()
  await expandButton(page, LABELS[PI_MISSING]).click()
  await expect(page.getByRole('status')).toContainText('unavailable')
  await expect(missing.locator('.empty-tag')).toHaveCount(0)

  // A folder link into an unavailable location explains itself instead of showing an empty folder.
  await openGraph(page, browseUrl('Pi', PI_MISSING, 'anything'))
  await expect(page.getByRole('alert')).toContainText(`location ${LABELS[PI_MISSING]} is unavailable`)
  await expect(page.getByRole('alert')).toContainText('does not exist')

  // Restore the root: the next Refresh picks it up without a restart and its files can be opened.
  created.push(roots.piMissing)
  await mkdir(roots.piMissing)
  await writeFile(join(roots.piMissing, 'restored.md'), '# Restored\n')
  await openGraph(page, browseUrl('Pi', PI_MISSING))
  await expect(folderInfo(page)).toHaveText('0 folders, 1 Markdown file')
  await expect(node(page, `Pi/${PI_MISSING}`)).not.toHaveClass(/is-unavailable/)
  await expect(node(page, `Pi/${PI_MISSING}/restored.md`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'New file…' })).toBeEnabled()
  await nodeBody(page, `Pi/${PI_MISSING}/restored.md`).click()
  await expect(page.getByRole('tabpanel')).toContainText('Restored')
  await page.getByRole('button', { name: 'Back to folder' }).click()

  // Remove it again: Refresh reports it unavailable while everything else keeps working.
  await rm(roots.piMissing, { recursive: true, force: true })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(node(page, `Pi/${PI_MISSING}`)).toHaveClass(/is-unavailable/)
  await expect(node(page, `Pi/${PI_MISSING}/restored.md`)).toHaveCount(0)
  await expect(folderInfo(page)).toContainText('Unavailable')
  await expandLocation(page, 'Pi', PI)
  await expect(node(page, `Pi/${PI}/workflow.md`)).toBeVisible()
})

test('creating at a source node requires choosing an available location; the file lands in that location', async ({ page }) => {
  await openGraph(page, '/browse/Pi')
  await expect(page.getByRole('button', { name: 'New file…' })).toBeEnabled()
  const posts: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/mutate')) posts.push(request.postData() ?? '') })
  await page.getByRole('button', { name: 'New file…' }).click()
  const form = dialog(page)
  await expect(form).toContainText('choose which configured location')
  const location = form.getByRole('combobox', { name: 'Location' })
  await expect(location).toHaveValue('')
  const options = await location.locator('option').allTextContents()
  expect(options).toContain(LABELS[PI])
  expect(options).toContain(LABELS[PI_PACKAGE])
  expect(options).not.toContain(LABELS[PI_MISSING])
  expect(options.some(option => option.includes('Claude') || option === LABELS[CLAUDE])).toBe(false)
  const name = await scratchName()
  await form.getByRole('textbox', { name: 'File name' }).fill(name)
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form.getByRole('alert')).toContainText('Choose a location')
  expect(posts).toHaveLength(0)

  created.push(join(roots.piPackage, name))
  await location.selectOption({ label: LABELS[PI_PACKAGE] })
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(fileUrl('Pi', PI_PACKAGE, name))
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0])).toEqual({ op: 'create-file', source: 'Pi', locationId: PI_PACKAGE, path: name })
  expect(await exists(join(roots.piPackage, name))).toBe(true)
  expect(await exists(join(roots.piPersonal, name))).toBe(false)
  await expect(outcome(page)).toContainText(`Created ${name} in Pi / ${LABELS[PI_PACKAGE]}`)
  await expect(page.getByTestId('installed-notice')).toBeVisible()

  // Creating a folder from a location node needs no choice: the location is fixed.
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await nodeBody(page, `Pi/${PI}`).click()
  await page.getByRole('button', { name: 'New folder…' }).click()
  await expect(dialog(page).getByRole('combobox', { name: 'Location' })).toHaveCount(0)
  await expect(dialog(page)).toContainText(`Pi / ${LABELS[PI]}`)
  const folder = await scratchName('')
  created.push(join(roots.piPersonal, folder))
  await dialog(page).getByRole('textbox', { name: 'Folder name' }).fill(folder)
  await dialog(page).getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, folder))
  expect((await stat(join(roots.piPersonal, folder))).isDirectory()).toBe(true)
  // Location nodes themselves are never rename/move/delete targets.
  await nodeBody(page, `Pi/${PI}`).click()
  for (const name of ['Rename…', 'Move…', 'Delete…']) await expect(page.getByRole('button', { name })).toBeDisabled()
})

test('copy chooses a destination location under the other source, then a folder in it; move never crosses locations', async ({ page }) => {
  const name = await scratchName()
  const source = join(roots.piPersonal, name)
  created.push(source)
  await writeFile(source, '# copy me\n')
  await page.goto(fileUrl('Pi', PI, name))
  await page.getByRole('button', { name: 'Copy to Claude…' }).click()
  const form = dialog(page)
  const location = form.getByRole('combobox', { name: 'Destination location' })
  await expect(location).toHaveValue('')
  expect(await location.locator('option').allTextContents()).toEqual(expect.arrayContaining([LABELS[CLAUDE], LABELS[CLAUDE_PLUGIN]]))
  expect((await location.locator('option').allTextContents()).some(option => option === LABELS[PI] || option === LABELS[PI_PACKAGE])).toBe(false)
  await expect(form.getByRole('combobox', { name: 'Destination folder' })).toHaveCount(0)
  await form.getByRole('button', { name: 'Copy' }).click()
  await expect(form.getByRole('alert')).toContainText('Choose a destination location')

  await location.selectOption({ label: LABELS[CLAUDE_PLUGIN] })
  const folder = form.getByRole('combobox', { name: 'Destination folder' })
  const folders = await folder.locator('option').allTextContents()
  expect(folders).toContain('review')
  expect(folders.some(option => option.includes('subagents'))).toBe(false)
  await folder.selectOption({ label: 'review' })
  created.push(join(roots.claudePlugin, 'review', name))
  await form.getByRole('button', { name: 'Copy' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(outcome(page)).toContainText(`Copied ${name} to Claude / ${LABELS[CLAUDE_PLUGIN]} / review/${name}`)
  expect(await readFile(join(roots.claudePlugin, 'review', name), 'utf8')).toBe('# copy me\n')
  expect(await exists(join(roots.claudePersonal, name))).toBe(false)
  await expect(page).toHaveURL(fileUrl('Pi', PI, name))

  // Move offers folders of the file's own location only.
  await page.getByRole('button', { name: 'Move…' }).click()
  const destinations = await dialog(page).getByRole('combobox', { name: 'Destination folder' }).locator('option').allTextContents()
  expect(destinations).toContain('skills')
  expect(destinations.some(option => option.includes('review'))).toBe(false)
  await expect(dialog(page)).toContainText(LABELS[PI])
  await expect(dialog(page).getByRole('combobox', { name: 'Destination location' })).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
})

test('old fixture-layout links are explained with per-location choices and never resolved automatically', async ({ page }) => {
  for (const url of ['/Pi', '/Pi/skills', '/file/Pi/workflow.md']) {
    await page.goto(url)
    await expect(page.getByRole('alert')).toContainText('old fixture layout')
    await expect(page.getByRole('alert')).toContainText(url)
    await expect(page.getByTestId('document-view')).toHaveCount(0)
    await expect(page.locator('.graph-canvas')).toBeVisible()
    await expect(page.getByRole('alert').getByRole('link', { name: LABELS[PI] })).toBeVisible()
    await expect(page.getByRole('alert').getByRole('link', { name: LABELS[PI_PACKAGE] })).toBeVisible()
    await expect(page).toHaveURL(url)
  }
  // The old nested document link parses as a file in an unconfigured location and is refused the same way:
  // no document is ever shown, and any request made before the listing arrives is rejected by the API.
  const statuses: number[] = []
  page.on('response', response => { if (response.url().includes('/api/file')) statuses.push(response.status()) })
  await page.goto('/file/Pi/skills/review.md')
  await expect(page.getByRole('alert')).toContainText('Location “skills” is not configured under Pi')
  await expect(page.getByTestId('document-view')).toHaveCount(0)
  await expect(page.getByRole('tabpanel')).toHaveCount(0)
  await page.getByRole('alert').getByRole('link', { name: LABELS[PI] }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(node(page, `Pi/${PI}/skills`)).toBeVisible()
  expect(statuses.every(status => status === 400)).toBe(true)
})

test('Refresh updates the listing without touching an open draft, and the document keeps its location identity', async ({ page }) => {
  const name = await scratchName()
  const path = join(roots.claudePersonal, name)
  created.push(path)
  await writeFile(path, 'draft base')
  await openGraph(page, browseUrl('Claude', CLAUDE))
  await nodeBody(page, `Claude/${CLAUDE}/${name}`).click()
  await expect(page.getByRole('tabpanel')).toContainText('draft base')
  await editButton(page).click()
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' plus unsaved')
  await expect(page.getByTestId('save-status')).toHaveText('Unsaved')

  const added = `scratch-added-${randomUUID().slice(0, 8)}.md`
  created.push(join(roots.claudePersonal, added))
  await writeFile(join(roots.claudePersonal, added), '')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await expect(editor(page)).toHaveText('draft base plus unsaved')
  await expect(page.getByTestId('save-status')).toHaveText('Unsaved')
  await expect(page.getByTestId('document-location')).toHaveText(LABELS[CLAUDE])
  await expect(page).toHaveURL(fileUrl('Claude', CLAUDE, name))

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  expect(await readFile(path, 'utf8')).toBe('draft base plus unsaved')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(node(page, `Claude/${CLAUDE}/${added}`)).toBeVisible()
})
