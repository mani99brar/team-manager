import { test, expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForApi } from './helpers.ts'

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url))
const created: string[] = []

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function scratchFile(source: 'pi' | 'claude', content: string) {
  const name = `scratch-${randomUUID().slice(0, 8)}.md`
  const path = join(fixtureRoot, source, name)
  created.push(path)
  await writeFile(path, content)
  return { name, path, url: `/file/${source === 'pi' ? 'Pi' : 'Claude'}/${encodeURIComponent(name)}` }
}

test.beforeEach(async ({ request }) => { await waitForApi(request) })
test.afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { force: true })
})

const editButton = (page: Page) => page.getByRole('button', { name: 'Edit', exact: true })
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })
const revertButton = (page: Page) => page.getByRole('button', { name: 'Revert', exact: true })
const saveStatus = (page: Page) => page.getByTestId('save-status')
const editor = (page: Page) => page.locator('.cm-content')
const dialog = (page: Page) => page.getByRole('dialog')

async function openForEditing(page: Page, url: string) {
  await page.goto(url)
  await expect(editButton(page)).toBeEnabled()
  await editButton(page).click()
  await expect(editor(page)).toBeVisible()
}

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

test('a save against a file changed on disk conflicts: Save and Revert are blocked, the draft is kept, Reload and Copy draft are offered', async ({ page }) => {
  const file = await scratchFile('pi', 'original\n')
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'my draft')
  await writeFile(file.path, 'changed outside\n')
  await saveButton(page).click()

  await expect(saveStatus(page)).toHaveText('Error')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('changed on disk')
  await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(alert.getByRole('button', { name: 'Copy draft' })).toBeVisible()
  await expect(alert.getByRole('button', { name: 'Retry' })).toHaveCount(0)
  await expect(saveButton(page)).toBeDisabled()
  await expect(revertButton(page)).toBeDisabled()
  expect(await editor(page).innerText()).toContain('my draft')
  expect(await readFile(file.path, 'utf8')).toBe('changed outside\n')

  // Neither Ctrl+S nor further typing sends anything while conflicted.
  const puts: string[] = []
  page.on('request', request => { if (request.method() === 'PUT') puts.push(request.url()) })
  await typeAtEnd(page, ' more')
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(300)
  expect(puts).toHaveLength(0)
  expect(await readFile(file.path, 'utf8')).toBe('changed outside\n')
  await expect(saveStatus(page)).toHaveText('Error')
})

test('Copy draft copies the current draft; when the clipboard is unavailable a selectable fallback is shown', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const file = await scratchFile('claude', 'base\n')
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'first')
  await writeFile(file.path, 'outside\n')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')
  // The draft keeps changing after the failed save; Copy draft copies what the editor holds now.
  await typeAtEnd(page, ' second')
  await page.getByRole('button', { name: 'Copy draft' }).click()
  await expect(page.getByRole('status')).toContainText('Draft copied')
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe('base\nfirst second')

  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })`)
  await page.getByRole('button', { name: 'Copy draft' }).click()
  await expect(page.getByRole('status')).not.toContainText('Draft copied')
  const fallback = page.getByRole('textbox', { name: 'Draft text' })
  await expect(fallback).toBeVisible()
  await expect(fallback).toHaveValue('base\nfirst second')
  await expect(page.getByTestId('editor').getByText(/clipboard is unavailable/i)).toBeVisible()
})

test('Reload asks before discarding the draft; cancel keeps it, failure keeps it, success installs a new baseline and hash', async ({ page }) => {
  const file = await scratchFile('pi', 'original\n')
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'draft')
  await writeFile(file.path, 'outside version\n')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')

  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(dialog(page)).toContainText('discard')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog(page)).toHaveCount(0)
  expect(await editor(page).innerText()).toContain('draft')
  await expect(saveButton(page)).toBeDisabled()

  // A failed fresh read keeps the draft and the conflict.
  await page.route('**/api/file?*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'READ_FAILED', error: 'nope' }) }))
  await page.getByRole('button', { name: 'Reload' }).click()
  await dialog(page).getByRole('button', { name: 'Reload' }).click()
  await expect(page.getByRole('status')).toContainText('Reloading')
  await expect(page.getByRole('status')).toContainText('failed')
  expect(await editor(page).innerText()).toContain('draft')
  await expect(saveButton(page)).toBeDisabled()
  await page.unroute('**/api/file?*')

  await page.getByRole('button', { name: 'Reload' }).click()
  await dialog(page).getByRole('button', { name: 'Reload' }).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await editor(page).innerText()).toContain('outside version')
  expect(await editor(page).innerText()).not.toContain('draft')
  await expect(saveButton(page)).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('document-view')).toHaveAttribute('data-hash', sha256('outside version\n'))

  await typeAtEnd(page, ' plus')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await readFile(file.path, 'utf8')).toBe('outside version\n plus')
})

test('Revert restores the Edit baseline on disk after several saves, through the hash check, after confirmation', async ({ page }) => {
  const file = await scratchFile('pi', 'baseline\n')
  await openForEditing(page, file.url)
  await expect(revertButton(page)).toBeDisabled()
  await typeAtEnd(page, 'one')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  await typeAtEnd(page, ' two')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await readFile(file.path, 'utf8')).toBe('baseline\none two')
  await expect(revertButton(page)).toBeEnabled()

  const puts: Array<Record<string, unknown>> = []
  page.on('request', request => { if (request.method() === 'PUT') puts.push(request.postDataJSON()) })
  await revertButton(page).click()
  await expect(dialog(page)).toContainText('discard')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  expect(puts).toHaveLength(0)
  await revertButton(page).click()
  await dialog(page).getByRole('button', { name: 'Revert' }).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(puts).toHaveLength(1)
  expect(puts[0]).toEqual({ source: 'Pi', path: file.name, content: 'baseline\n', expectedHash: sha256('baseline\none two') })
  expect(await readFile(file.path, 'utf8')).toBe('baseline\n')
  expect(await editor(page).innerText()).not.toContain('one two')
  await expect(page.getByRole('status')).toContainText('Reverted')
  await expect(revertButton(page)).toBeDisabled()

  // Saving again after a revert uses the hash returned by the revert.
  await typeAtEnd(page, 'three')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(puts[1].expectedHash).toBe(sha256('baseline\n'))
  expect(await readFile(file.path, 'utf8')).toBe('baseline\nthree')
})

test('a stale or failed Revert keeps the pre-Revert draft and explains recovery; Revert is unavailable while a save is pending', async ({ page }) => {
  const file = await scratchFile('claude', 'baseline\n')
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'saved edit')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  await typeAtEnd(page, ' unsaved edit')

  // Stale: the file changed outside since the last acknowledged save.
  await writeFile(file.path, 'outside\n')
  await revertButton(page).click()
  await dialog(page).getByRole('button', { name: 'Revert' }).click()
  await expect(saveStatus(page)).toHaveText('Error')
  await expect(page.getByRole('alert')).toContainText('changed on disk')
  expect(await editor(page).innerText()).toContain('saved edit unsaved edit')
  expect(await readFile(file.path, 'utf8')).toBe('outside\n')
  await expect(revertButton(page)).toBeDisabled()

  // Recover by reloading, then a Revert that fails at the server keeps the draft too.
  await page.getByRole('button', { name: 'Reload' }).click()
  await dialog(page).getByRole('button', { name: 'Reload' }).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  await typeAtEnd(page, 'again')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  await typeAtEnd(page, ' pending')
  let hold = true
  await page.route('**/api/file', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    if (hold) await expect.poll(() => hold, { timeout: 10_000 }).toBe(false)
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'WRITE_FAILED', error: 'disk error' }) })
  })
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saving')
  await expect(revertButton(page)).toBeDisabled()
  hold = false
  await expect(saveStatus(page)).toHaveText('Error')
  await expect(revertButton(page)).toBeEnabled()
  await revertButton(page).click()
  await dialog(page).getByRole('button', { name: 'Revert' }).click()
  await expect(saveStatus(page)).toHaveText('Error')
  await expect(page.getByRole('alert')).toContainText('failed')
  expect(await editor(page).innerText()).toContain('again pending')
  expect(await readFile(file.path, 'utf8')).toBe('outside\nagain')
})

test('in-app navigation with a dirty draft asks "Discard changes?"; Cancel keeps everything, Edit/Preview never asks', async ({ page }) => {
  const file = await scratchFile('pi', 'nav\n')
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'dirty')
  await page.getByRole('tab', { name: 'Preview' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await page.getByRole('tab', { name: 'Edit' }).click()

  for (const trigger of ['Back to folder', 'Done'] as const) {
    await page.getByRole('button', { name: trigger, exact: true }).click()
    await expect(dialog(page)).toContainText('Discard changes?')
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page).toHaveURL(file.url)
    await expect(editor(page)).toBeVisible()
    expect(await editor(page).innerText()).toContain('dirty')
    await expect(page.getByRole('button', { name: trigger, exact: true })).toBeFocused()
  }
  const home = page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' })
  await home.click()
  await expect(dialog(page)).toContainText('Discard changes?')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(page).toHaveURL(file.url)
  await expect(home).toBeFocused()
  await expect(saveStatus(page)).toHaveText('Unsaved')

  // Discard through the breadcrumb: the draft is gone and the file on disk is unchanged.
  await home.click()
  await dialog(page).getByRole('button', { name: 'Discard' }).click()
  await expect(page).toHaveURL('/')
  await expect(page.locator('.graph-canvas')).toBeVisible()
  expect(await readFile(file.path, 'utf8')).toBe('nav\n')
  await page.goto(file.url)
  await expect(page.getByRole('tabpanel')).not.toContainText('dirty')
})

test('Done with a clean draft leaves editing and shows the saved content; a dirty Done can be discarded', async ({ page }) => {
  const file = await scratchFile('claude', 'done\n')
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'kept')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Rendered' })).toBeVisible()
  await expect(page.getByRole('tabpanel')).toContainText('done kept')
  await expect(editButton(page)).toBeFocused()

  await editButton(page).click()
  await typeAtEnd(page, ' lost')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Discard' }).click()
  await expect(page.getByRole('tabpanel')).toContainText('done kept')
  await expect(page.getByRole('tabpanel')).not.toContainText('lost')
  expect(await readFile(file.path, 'utf8')).toBe('done\nkept')
})

test('while a save is pending, app navigation is refused with an explanation until it settles', async ({ page }) => {
  const file = await scratchFile('pi', 'pending\n')
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/file', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    await held
    return route.fallback()
  })
  await openForEditing(page, file.url)
  await typeAtEnd(page, 'x')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saving')
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page).toHaveURL(file.url)
  await expect(page.getByRole('alert')).toContainText('save')
  await expect(page.getByRole('alert')).toContainText('finish')
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeDisabled()
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Home' }).click()
  await expect(page).toHaveURL(file.url)
  release()
  await expect(saveStatus(page)).toHaveText('Saved')
  await page.getByRole('button', { name: 'Back to folder' }).click()
  await expect(page).toHaveURL('/Pi')
  expect(await readFile(file.path, 'utf8')).toBe('pending\nx')
})

test('beforeunload warns only while there is unsaved or unacknowledged work', async ({ page }) => {
  const file = await scratchFile('pi', 'unload\n')
  const warns = () => page.evaluate(`(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })()`)
  await openForEditing(page, file.url)
  expect(await warns()).toBe(false)
  await typeAtEnd(page, 'dirty')
  await expect(saveStatus(page)).toHaveText('Unsaved')
  expect(await warns()).toBe(true)
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await warns()).toBe(false)
  // A failed save is unacknowledged work.
  await page.route('**/api/file', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'WRITE_FAILED', error: 'x' }) })
    : route.fallback())
  await typeAtEnd(page, ' failed')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')
  expect(await warns()).toBe(true)
  await page.unroute('**/api/file')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await warns()).toBe(false)

  // The native dialog appears on reload after a real interaction; dismissing it keeps the page and draft.
  await typeAtEnd(page, ' again')
  await expect(saveStatus(page)).toHaveText('Unsaved')
  const nativeDialog = page.waitForEvent('dialog')
  await page.evaluate('setTimeout(() => location.reload(), 0)')
  const shown = await nativeDialog
  expect(shown.type()).toBe('beforeunload')
  await shown.dismiss()
  await expect(editor(page)).toBeVisible()
  expect(await editor(page).innerText()).toContain('again')
})

test('browser Back after a failed save is not intercepted and loses the draft; returning reads the disk', async ({ page }) => {
  const file = await scratchFile('claude', 'history\n')
  await page.goto('/Claude')
  await page.getByRole('button', { name: 'Outline' }).click()
  await page.getByRole('navigation', { name: 'Directory outline' }).getByRole('button', { name: new RegExp(`^${file.name}\\s*, Markdown file$`) }).click()
  await editButton(page).click()
  await page.route('**/api/file', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'WRITE_FAILED', error: 'x' }) })
    : route.fallback())
  await typeAtEnd(page, 'lost draft')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')
  await page.goBack()
  await expect(page).toHaveURL('/Claude')
  await expect(dialog(page)).toHaveCount(0)
  await page.goForward()
  await expect(page).toHaveURL(file.url)
  await expect(page.getByRole('tab', { name: 'Rendered' })).toBeVisible()
  await expect(page.getByRole('tabpanel')).toContainText('history')
  await expect(page.getByRole('tabpanel')).not.toContainText('lost draft')
  await expect(editor(page)).toHaveCount(0)
  expect(await readFile(file.path, 'utf8')).toBe('history\n')
})

for (const [initial, fresh] of [
  ['\uFEFFold\r\ntext', 'NEW disk\ntext'],
  ['old\ntext', '\uFEFFNEW disk\r\ntext'],
  ['old\r\ntext', 'NEW disk\ntext'],
]) {
  test(`Reload refreshes serialization metadata ${JSON.stringify(initial)} to ${JSON.stringify(fresh)}`, async ({ page }) => {
    const file = await scratchFile('pi', initial)
    await openForEditing(page, file.url)
    await typeAtEnd(page, ' draft')
    await writeFile(file.path, fresh)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('Error')
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(saveStatus(page)).toHaveText('Saved')
    await expect(editor(page)).toHaveText('NEW disktext')
    await typeAtEnd(page, '!')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('Saved')
    expect(await readFile(file.path, 'utf8')).toBe(fresh + '!')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await editButton(page).click()
    await typeAtEnd(page, '?')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('Saved')
    expect(await readFile(file.path, 'utf8')).toBe(fresh + '!?')
  })
}

for (const bytes of [Buffer.from('mixed\r\nline\nend'), Buffer.from([0xff, 0x61])]) {
  test(`Reload of non-roundtrippable bytes stays read-only and retains recovery draft: ${bytes.toString('hex')}`, async ({ page }) => {
    const file = await scratchFile('pi', 'original')
    await openForEditing(page, file.url)
    await typeAtEnd(page, ' draft')
    await writeFile(file.path, bytes)
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('Error')
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByTestId('editor')).toContainText('read-only')
    await expect(saveButton(page)).toBeDisabled()
    await expect(revertButton(page)).toBeDisabled()
    await expect(page.getByRole('textbox', { name: 'Draft before reload' })).toHaveValue('original draft')
    // Retrying a still-uneditable disk read must not replace the recovery draft with decoded disk text.
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Draft before reload' })).toHaveValue('original draft')
    await page.keyboard.press('Control+s')
    expect(await readFile(file.path)).toEqual(bytes)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(editButton(page)).toBeDisabled()
    await expect(page.getByTestId('edit-unavailable')).toBeVisible()
  })
}

test('pending Reload cannot be dismissed with Escape', async ({ page }) => {
  const file = await scratchFile('pi', 'original')
  await openForEditing(page, file.url)
  await typeAtEnd(page, ' draft')
  await writeFile(file.path, 'fresh')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/file?**', async route => { await held; await route.continue() })
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toBeVisible()
  release()
  await expect(dialog(page)).toHaveCount(0)
  await expect(editor(page)).toHaveText('fresh')
})

test('a Reload response from a session abandoned through history cannot affect the new editor', async ({ page }) => {
  const file = await scratchFile('pi', 'original')
  // Establish app-owned history so Back leaves editing without a full page reload.
  await page.goto('/Pi')
  await page.locator(`.graph-canvas [data-node-id="Pi/${file.name}"] .node-body`).focus()
  await page.keyboard.press('Enter')
  await editButton(page).click()
  await typeAtEnd(page, ' draft')
  await writeFile(file.path, 'fresh')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let received!: () => void
  const ready = new Promise<void>(resolve => { received = resolve })
  await page.route('**/api/file?**', async route => {
    const response = await route.fetch()
    received()
    await held
    await route.fulfill({ response })
  }, { times: 1 })
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
  await ready
  await page.goBack()
  await expect(dialog(page)).toHaveCount(0)
  await page.goForward()
  await editButton(page).click()
  await typeAtEnd(page, ' new draft')
  release()
  await expect(editor(page)).toHaveText('fresh new draft')
  await expect(saveStatus(page)).toHaveText('Unsaved')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await readFile(file.path, 'utf8')).toBe('fresh new draft')
})

test('a read-only Reload can recover to a new editable baseline without dropping the retained draft', async ({ page }) => {
  const file = await scratchFile('pi', 'original')
  await openForEditing(page, file.url)
  await typeAtEnd(page, ' draft')
  await writeFile(file.path, 'mixed\r\nline\nend')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Error')
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(saveButton(page)).toBeDisabled()
  await expect(page.getByRole('textbox', { name: 'Draft before reload' })).toHaveValue('original draft')
  const fresh = '\uFEFFnew\r\neditable'
  await writeFile(file.path, fresh)
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await dialog(page).getByRole('button', { name: 'Reload', exact: true }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(saveButton(page)).toBeEnabled()
  await expect(page.getByRole('textbox', { name: 'Draft before reload' })).toHaveValue('original draft')
  await typeAtEnd(page, '!')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await readFile(file.path, 'utf8')).toBe(fresh + '!')
})
