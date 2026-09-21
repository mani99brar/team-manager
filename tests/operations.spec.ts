import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CLAUDE, LABELS, PI, browseUrl, expandButton, expandLocation, fileUrl, node, nodeBody, openGraph, roots, waitForApi } from './helpers.ts'

const created: string[] = []

/** Every test works inside its own scratch folders (one per personal location), removed recursively afterwards. */
async function scratchFolders() {
  const name = `scratch-${randomUUID().slice(0, 8)}`
  const pi = join(roots.piPersonal, name)
  const claude = join(roots.claudePersonal, name)
  created.push(pi, claude)
  await mkdir(pi)
  await mkdir(claude)
  return { name, pi, claude }
}

async function exists(path: string) {
  try { await stat(path); return true } catch { return false }
}

test.beforeEach(async ({ request }) => { await waitForApi(request) })
test.afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
})

const dialog = (page: Page) => page.getByRole('dialog')
const outcome = (page: Page) => page.getByTestId('operation-outcome')
const editButton = (page: Page) => page.getByRole('button', { name: 'Edit', exact: true })
const editor = (page: Page) => page.locator('.cm-content')

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

test('New file in the selected folder validates the name, prevents double submit, shows server conflicts, then opens the file', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'taken.md'), 'taken')
  await openGraph(page, browseUrl('Pi', PI, scratch.name))
  await expect(node(page, `Pi/${PI}/${scratch.name}`)).toHaveClass(/is-selected/)

  const posts: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/mutate')) posts.push(request.postData() ?? '') })
  await page.getByRole('button', { name: 'New file…' }).click()
  const form = dialog(page)
  await expect(form).toContainText(`Pi / ${LABELS[PI]} / ${scratch.name}`)
  await expect(form.getByRole('combobox', { name: 'Location' })).toHaveCount(0)
  const name = form.getByRole('textbox', { name: 'File name' })
  await name.fill('notes.txt')
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form.getByRole('alert')).toContainText('.md')
  await name.fill('a/b.md')
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form.getByRole('alert')).toContainText('/')
  expect(posts).toHaveLength(0)

  await name.fill('taken.md')
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form.getByRole('alert')).toContainText('already exists')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0])).toEqual({ op: 'create-file', source: 'Pi', locationId: PI, path: `${scratch.name}/taken.md` })
  await expect(form).toBeVisible()

  // Double submit: while the request is pending the button is disabled and only one request goes out.
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/mutate', async route => { await held; await route.continue() })
  await name.fill('fresh.md')
  const create = form.getByRole('button', { name: 'Create' })
  await create.click()
  await expect(create).toBeDisabled()
  await create.click({ force: true })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  expect(posts).toHaveLength(2)
  const completed = page.waitForResponse(response => response.url().includes('/api/mutate'))
  release()
  await completed
  await page.unroute('**/api/mutate')

  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/fresh.md`))
  await expect(page.getByRole('heading', { level: 2, name: 'fresh.md' })).toBeVisible()
  await expect(page.getByRole('tabpanel')).toContainText('This file is empty.')
  expect(await readFile(join(scratch.pi, 'fresh.md'), 'utf8')).toBe('')
  await expect(outcome(page)).toContainText(`Created fresh.md in Pi / ${LABELS[PI]} / ${scratch.name}`)
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(node(page, `Pi/${PI}/${scratch.name}/fresh.md`)).toBeVisible()
  await expect(node(page, `Pi/${PI}/${scratch.name}/taken.md`)).toBeVisible()
})

test('New folder reveals and selects the folder; unrelated expansion and pins are kept', async ({ page }) => {
  const scratch = await scratchFolders()
  await openGraph(page, browseUrl('Pi', PI, scratch.name))
  await expandLocation(page, 'Claude', CLAUDE)
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toBeVisible()
  await nodeBody(page, `Claude/${CLAUDE}/subagents`).focus()
  await page.keyboard.press('p')
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toHaveClass(/is-pinned/)

  await page.getByRole('button', { name: 'New folder…' }).click()
  await dialog(page).getByRole('textbox', { name: 'Folder name' }).fill('topics')
  await dialog(page).getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, `${scratch.name}/topics`))
  await expect(node(page, `Pi/${PI}/${scratch.name}/topics`)).toHaveClass(/is-selected/)
  await expect(page.getByTestId('folder-info')).toHaveText('This folder is empty.')
  expect((await stat(join(scratch.pi, 'topics'))).isDirectory()).toBe(true)
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toBeVisible()
  await expect(node(page, `Claude/${CLAUDE}/subagents`)).toHaveClass(/is-pinned/)
  await expect(outcome(page)).toContainText('Created folder topics')
  await expect(page.getByRole('button', { name: 'New folder…' })).toBeFocused()
})

test('Rename of the active file updates the URL and identity; it is refused while the draft is dirty', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'old.md'), '# Old\n')
  await page.goto(fileUrl('Pi', PI, `${scratch.name}/old.md`))
  await editButton(page).click()
  await typeAtEnd(page, 'dirty')
  await page.getByRole('button', { name: 'Rename…' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText(/save or discard/i)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')

  await page.getByRole('button', { name: 'Rename…' }).click()
  const name = dialog(page).getByRole('textbox', { name: 'New name' })
  await expect(name).toHaveValue('old.md')
  await name.fill('renamed.md')
  await dialog(page).getByRole('button', { name: 'Rename' }).click()
  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/renamed.md`))
  await expect(page.getByRole('heading', { level: 2, name: 'renamed.md' })).toBeVisible()
  await expect(page.getByTestId('document-meta')).toContainText(`${scratch.name}/renamed.md`)
  await expect(page.getByTestId('document-location')).toHaveText(LABELS[PI])
  await expect(page.getByRole('tabpanel')).toContainText('Old')
  expect(await readFile(join(scratch.pi, 'renamed.md'), 'utf8')).toBe('# Old\ndirty')
  expect(await exists(join(scratch.pi, 'old.md'))).toBe(false)
  await page.reload()
  await expect(page.getByRole('heading', { level: 2, name: 'renamed.md' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(node(page, `Pi/${PI}/${scratch.name}/renamed.md`)).toBeVisible()
  await expect(node(page, `Pi/${PI}/${scratch.name}/old.md`)).toHaveCount(0)
})

test('Move offers only folders of the same location and updates the active file URL; folders can be moved from the browser', async ({ page }) => {
  const scratch = await scratchFolders()
  await mkdir(join(scratch.pi, 'inbox'))
  await mkdir(join(scratch.pi, 'archive'))
  await mkdir(join(scratch.pi, 'inbox', 'empty'))
  await writeFile(join(scratch.pi, 'inbox', 'todo.md'), 'todo')
  await page.goto(fileUrl('Pi', PI, `${scratch.name}/inbox/todo.md`))
  await page.getByRole('button', { name: 'Move…' }).click()
  const destination = dialog(page).getByRole('combobox', { name: 'Destination folder' })
  const options = await destination.locator('option').allTextContents()
  expect(options).toContain(`${scratch.name}/archive`)
  expect(options).not.toContain(`${scratch.name}/inbox`)
  expect(options.some(option => option.includes('Claude'))).toBe(false)
  // Folders of other Pi locations (the package's review/) are never offered: moves stay within one location.
  expect(options.some(option => option === 'review')).toBe(false)
  await destination.selectOption({ label: `${scratch.name}/archive` })
  await dialog(page).getByRole('button', { name: 'Move' }).click()
  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/archive/todo.md`))
  await expect(page.getByTestId('document-meta')).toContainText(`${scratch.name}/archive/todo.md`)
  expect(await readFile(join(scratch.pi, 'archive', 'todo.md'), 'utf8')).toBe('todo')

  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, `${scratch.name}/archive`))
  await nodeBody(page, `Pi/${PI}/${scratch.name}/inbox`).click()
  await expandButton(page, 'inbox').click()
  await nodeBody(page, `Pi/${PI}/${scratch.name}/inbox/empty`).click()
  await page.getByRole('button', { name: 'Move…' }).click()
  await dialog(page).getByRole('combobox', { name: 'Destination folder' }).selectOption({ label: `${scratch.name}/archive` })
  await dialog(page).getByRole('button', { name: 'Move' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, `${scratch.name}/archive/empty`))
  await expect(node(page, `Pi/${PI}/${scratch.name}/archive/empty`)).toHaveClass(/is-selected/)
  expect(await exists(join(scratch.pi, 'archive', 'empty'))).toBe(true)
  expect(await exists(join(scratch.pi, 'inbox', 'empty'))).toBe(false)
})

test('Delete confirms with the full source, location and path, refuses nonempty folders, and returns to the containing folder', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'doomed.md'), 'doomed')
  await mkdir(join(scratch.pi, 'full'))
  await writeFile(join(scratch.pi, 'full', '.hidden'), '')
  await mkdir(join(scratch.pi, 'empty'))
  await page.goto(fileUrl('Pi', PI, `${scratch.name}/doomed.md`))
  await page.getByRole('button', { name: 'Delete…' }).click()
  await expect(dialog(page)).toContainText(`Pi / ${LABELS[PI]} / ${scratch.name}/doomed.md`)
  await expect(dialog(page)).toContainText('cannot be undone')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog(page)).toHaveCount(0)
  expect(await exists(join(scratch.pi, 'doomed.md'))).toBe(true)
  await expect(page.getByRole('button', { name: 'Delete…' })).toBeFocused()

  await page.getByRole('button', { name: 'Delete…' }).click()
  await dialog(page).getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, scratch.name))
  await expect(node(page, `Pi/${PI}/${scratch.name}`)).toHaveClass(/is-selected/)
  await expect(node(page, `Pi/${PI}/${scratch.name}/doomed.md`)).toHaveCount(0)
  expect(await exists(join(scratch.pi, 'doomed.md'))).toBe(false)
  await expect(outcome(page)).toContainText('Deleted doomed.md')

  await nodeBody(page, `Pi/${PI}/${scratch.name}/full`).click()
  await page.getByRole('button', { name: 'Delete…' }).click()
  await dialog(page).getByRole('button', { name: 'Delete' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('not empty')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  expect(await exists(join(scratch.pi, 'full', '.hidden'))).toBe(true)

  await nodeBody(page, `Pi/${PI}/${scratch.name}/empty`).click()
  await page.getByRole('button', { name: 'Delete…' }).click()
  await dialog(page).getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, scratch.name))
  await expect(node(page, `Pi/${PI}/${scratch.name}/empty`)).toHaveCount(0)
  expect(await exists(join(scratch.pi, 'empty'))).toBe(false)
  // Sources and locations offer no rename/move/delete.
  for (const id of [`Pi/${PI}`, 'Pi']) {
    await nodeBody(page, id).click()
    await expect(page.getByRole('button', { name: 'Delete…' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Rename…' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Move…' })).toBeDisabled()
  }
})

test('Copy sends saved bytes to a chosen location of the other source, keeps the original open, and is labelled/disabled around drafts', async ({ page }) => {
  const scratch = await scratchFolders()
  const bytes = Buffer.from('---\r\nname: x\r\n---\r\n# Copy me\r\n', 'utf8')
  await writeFile(join(scratch.pi, 'copy.md'), bytes)
  await page.goto(fileUrl('Pi', PI, `${scratch.name}/copy.md`))
  await expect(page.getByRole('button', { name: 'Copy to Claude…' })).toBeVisible()
  await editButton(page).click()
  await typeAtEnd(page, 'unsaved')
  const copyButton = page.getByRole('button', { name: 'Copy saved content to Claude…' })
  await expect(copyButton).toBeVisible()

  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/file', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    await held
    return route.fallback()
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('save-status')).toHaveText('Saving')
  await expect(copyButton).toBeDisabled()
  release()
  await expect(page.getByTestId('save-status')).toHaveText('Saved')
  await typeAtEnd(page, ' more')
  await expect(copyButton).toBeEnabled()

  await copyButton.click()
  await expect(dialog(page)).toContainText('saved content')
  await expect(dialog(page)).toContainText('frontmatter')
  await dialog(page).getByRole('combobox', { name: 'Destination location' }).selectOption({ label: LABELS[CLAUDE] })
  const destination = dialog(page).getByRole('combobox', { name: 'Destination folder' })
  const options = await destination.locator('option').allTextContents()
  expect(options).toContain(scratch.name)
  // Folders of the file's own source (Pi's skills/) are never offered as a copy destination.
  expect(options.includes('skills')).toBe(false)
  await destination.selectOption({ label: scratch.name })
  await expect(dialog(page).getByRole('textbox', { name: 'File name' })).toHaveValue('copy.md')
  await dialog(page).getByRole('button', { name: 'Copy' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/copy.md`))
  await expect(outcome(page)).toContainText(`Copied copy.md to Claude / ${LABELS[CLAUDE]} / ${scratch.name}/copy.md`)
  expect(await editor(page).innerText()).toContain('more')
  expect((await readFile(join(scratch.claude, 'copy.md'))).toString('hex')).toBe(Buffer.concat([bytes, Buffer.from('unsaved')]).toString('hex'))
})

test('a successful operation followed by a failed listing refresh reports both and offers Refresh, not a repeat', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'gone.md'), 'x')
  await openGraph(page, browseUrl('Pi', PI, scratch.name))
  await nodeBody(page, `Pi/${PI}/${scratch.name}/gone.md`).click()
  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/gone.md`))
  await page.route('**/api/entries', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'listing down' }) }))
  await page.getByRole('button', { name: 'Delete…' }).click()
  await dialog(page).getByRole('button', { name: 'Delete' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Deleted gone.md')
  await expect(alert).toContainText('listing')
  expect(await exists(join(scratch.pi, 'gone.md'))).toBe(false)
  await expect(alert.getByRole('button', { name: 'Refresh' })).toBeVisible()
  await expect(alert.getByRole('button', { name: /Delete|Retry/ })).toHaveCount(0)
  await page.unroute('**/api/entries')
  await alert.getByRole('button', { name: 'Refresh' }).click()
  await expect(page).toHaveURL(browseUrl('Pi', PI, scratch.name))
  await expect(node(page, `Pi/${PI}/${scratch.name}/gone.md`)).toHaveCount(0)
})

test('operations are keyboard accessible and usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  const scratch = await scratchFolders()
  await openGraph(page, browseUrl('Claude', CLAUDE, scratch.name))
  const newFile = page.getByRole('button', { name: 'New file…' })
  await newFile.focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).getByRole('textbox', { name: 'File name' })).toBeFocused()
  const box = await dialog(page).getByRole('button', { name: 'Create' }).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x + box!.width).toBeLessThanOrEqual(360)
  expect(box!.y + box!.height).toBeLessThanOrEqual(640)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(newFile).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.type('keyboard.md')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(fileUrl('Claude', CLAUDE, `${scratch.name}/keyboard.md`))
  expect(await exists(join(scratch.claude, 'keyboard.md'))).toBe(true)
  const overflow = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  expect(overflow).toBe(0)
})

test('pending Rename cannot Escape into an editable draft before the response', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'old.md'), 'original')
  await page.goto(fileUrl('Pi', PI, `${scratch.name}/old.md`))
  await expect(editButton(page)).toBeEnabled()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/mutate', async route => { const response = await route.fetch(); await held; await route.fulfill({ response }) })
  await page.getByRole('button', { name: 'Rename…' }).click()
  await dialog(page).getByRole('textbox', { name: 'New name' }).fill('new.md')
  await dialog(page).getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeVisible()
  release()
  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/new.md`))
  await expect(outcome(page)).toContainText('Renamed')
})

test('delayed create listing refresh cannot abandon a newly opened dirty editor', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'existing.md'), 'original')
  await openGraph(page, browseUrl('Pi', PI, scratch.name))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/entries', async route => { const response = await route.fetch(); await held; await route.fulfill({ response }) })
  await page.getByRole('button', { name: 'New file…' }).click()
  await dialog(page).getByRole('textbox', { name: 'File name' }).fill('created.md')
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await nodeBody(page, `Pi/${PI}/${scratch.name}/existing.md`).dblclick()
  await editButton(page).click()
  await typeAtEnd(page, ' precious draft')
  release()
  await expect(outcome(page)).toContainText('Created created.md')
  await expect(page).toHaveURL(fileUrl('Pi', PI, `${scratch.name}/existing.md`))
  await expect(editor(page)).toHaveText('original precious draft')
  await expect(page.getByTestId('save-status')).toHaveText('Unsaved')
})

for (const op of ['rename', 'move', 'delete', 'create-file', 'create-folder'] as const) {
  test(`late ${op} response after native history navigation does not navigate again`, async ({ page }) => {
    const scratch = await scratchFolders()
    await writeFile(join(scratch.pi, 'existing.md'), 'original')
    if (op === 'move') await mkdir(join(scratch.pi, 'destination'))
    await openGraph(page, browseUrl('Pi', PI, scratch.name))
    await nodeBody(page, `Pi/${PI}/${scratch.name}/existing.md`).dblclick()
    await expect(editButton(page)).toBeEnabled()
    if (op.startsWith('create')) await page.getByRole('button', { name: 'Back to folder' }).click()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let received!: () => void
    const ready = new Promise<void>(resolve => { received = resolve })
    await page.route('**/api/mutate', async route => { const response = await route.fetch(); received(); await held; await route.fulfill({ response }) })
    const label = op === 'create-file' ? 'New file…' : op === 'create-folder' ? 'New folder…' : `${op[0].toUpperCase()}${op.slice(1)}…`
    await page.getByRole('button', { name: label, exact: true }).click()
    if (op === 'rename') await dialog(page).getByRole('textbox', { name: 'New name' }).fill('renamed.md')
    if (op === 'create-file') await dialog(page).getByRole('textbox', { name: 'File name' }).fill('created.md')
    if (op === 'create-folder') await dialog(page).getByRole('textbox', { name: 'Folder name' }).fill('created')
    // Keep move artifacts within this test's owned folder tree.
    if (op === 'move') await dialog(page).getByRole('combobox').selectOption(`${scratch.name}/destination`)
    await dialog(page).locator('[data-dialog-confirm]').click()
    await ready
    await page.goBack()
    const url = page.url()
    await expect(dialog(page)).toHaveCount(0)
    release()
    await expect(outcome(page)).toBeVisible()
    await expect(page).toHaveURL(url)
  })
}

test('delayed delete listing refresh respects a newer dirty editor even in the originating location', async ({ page }) => {
  const scratch = await scratchFolders()
  await writeFile(join(scratch.pi, 'existing.md'), 'original')
  const url = fileUrl('Pi', PI, `${scratch.name}/existing.md`)
  await page.goto(url)
  await expect(editButton(page)).toBeEnabled()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/entries', async route => { const response = await route.fetch(); await held; await route.fulfill({ response }) })
  await page.getByRole('button', { name: 'Delete…' }).click()
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await editButton(page).click()
  await typeAtEnd(page, ' keep this draft')
  release()
  await expect(outcome(page)).toContainText('Deleted existing.md')
  await expect(page).toHaveURL(url)
  await expect(editor(page)).toHaveText('original keep this draft')
  await expect(page.getByTestId('save-status')).toHaveText('Unsaved')
})

for (const op of ['rename', 'move', 'delete', 'create-folder'] as const) {
  test(`delayed folder ${op} listing refresh cannot navigate after history departure and return`, async ({ page }) => {
    const scratch = await scratchFolders()
    await mkdir(join(scratch.pi, 'empty'))
    await mkdir(join(scratch.pi, 'destination'))
    await writeFile(join(scratch.pi, 'existing.md'), 'original')
    await openGraph(page, browseUrl('Pi', PI, scratch.name))
    await nodeBody(page, `Pi/${PI}/${scratch.name}/empty`).click()
    const originalUrl = page.url()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/entries', async route => { const response = await route.fetch(); await held; await route.fulfill({ response }) })
    const label = op === 'create-folder' ? 'New folder…' : `${op[0].toUpperCase()}${op.slice(1)}…`
    await page.getByRole('button', { name: label, exact: true }).click()
    if (op === 'rename') await dialog(page).getByRole('textbox', { name: 'New name' }).fill('renamed')
    if (op === 'move') await dialog(page).getByRole('combobox').selectOption(`${scratch.name}/destination`)
    if (op === 'create-folder') await dialog(page).getByRole('textbox', { name: 'Folder name' }).fill('child')
    await dialog(page).locator('[data-dialog-confirm]').click()
    await expect(dialog(page)).toHaveCount(0)
    await page.goBack()
    await page.goForward()
    await expect(page).toHaveURL(originalUrl)
    release()
    await expect(outcome(page)).toBeVisible()
    await expect(page).toHaveURL(originalUrl)
  })
}
