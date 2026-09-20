import { test, expect, type Page, type Route } from '@playwright/test'
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

async function scratchFile(source: 'pi' | 'claude', content: string | Buffer, suffix = '.md') {
  const name = `scratch-${randomUUID().slice(0, 8)}${suffix}`
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
const saveStatus = (page: Page) => page.getByTestId('save-status')
const editor = (page: Page) => page.locator('.cm-content')

async function openForEditing(page: Page, url: string) {
  await page.goto(url)
  await expect(editButton(page)).toBeEnabled()
  await editButton(page).click()
  await expect(editor(page)).toBeVisible()
}

/** Places the caret at the end of the document and types. */
async function typeAtEnd(page: Page, text: string) {
  await editor(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
}

test('Edit is available only once a document is loaded; editing shows Edit/Preview tabs and highlighted CodeMirror', async ({ page }) => {
  const file = await scratchFile('pi', '# Heading\n\nSome [link](https://example.com) text.\n')
  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/file?*', async route => { await held; await route.continue() })
  await page.goto(file.url)
  await expect(page.getByTestId('document-view').getByText(`Loading ${file.name}`)).toBeVisible()
  await expect(editButton(page)).toHaveCount(0)
  release()
  await expect(editButton(page)).toBeEnabled()
  await page.unroute('**/api/file?*')

  await editButton(page).click()
  const tabs = page.getByRole('tablist', { name: 'Editor' })
  await expect(tabs.getByRole('tab', { name: 'Edit' })).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'false')
  await expect(editor(page)).toContainText('# Heading')
  await expect(saveStatus(page)).toHaveText('Saved')
  await expect(saveButton(page)).toBeVisible()
  // Rendered/Source tabs of the read-only view are replaced while editing.
  await expect(page.getByRole('tab', { name: 'Rendered' })).toHaveCount(0)

  // Markdown syntax highlighting: the heading token is bold and the link URL is coloured differently from plain text.
  type Styled = { getComputedStyle(element: unknown): { fontWeight: string; color: string } }
  const headingWeight = await editor(page).locator('.cm-line').first().locator('span').first().evaluate(element => (globalThis as unknown as Styled).getComputedStyle(element).fontWeight)
  expect(['700', 'bold']).toContain(headingWeight)
  const plainColor = await editor(page).locator('.cm-line').nth(2).evaluate(element => (globalThis as unknown as Styled).getComputedStyle(element).color)
  const urlColor = await editor(page).getByText('https://example.com').evaluate(element => (globalThis as unknown as Styled).getComputedStyle(element).color)
  expect(urlColor).not.toBe(plainColor)

  // Preview renders the current draft with the safe renderer, not the saved content.
  await typeAtEnd(page, '\n\n<div id="raw-element">raw</div>\n\n## Draft only')
  await tabs.getByRole('tab', { name: 'Preview' }).click()
  const preview = page.getByRole('tabpanel')
  await expect(preview.getByRole('heading', { level: 2, name: 'Draft only' })).toBeVisible()
  await expect(preview.locator('#raw-element')).toHaveCount(0)
  await expect(preview).toContainText('<div id="raw-element">raw</div>')
  await expect(saveStatus(page)).toHaveText('Unsaved')
  await tabs.getByRole('tab', { name: 'Edit' }).click()
  await expect(editor(page)).toContainText('## Draft only')
  // No write reached the disk.
  expect(await readFile(file.path, 'utf8')).toBe('# Heading\n\nSome [link](https://example.com) text.\n')
})

test('nothing is written on keystrokes, tab switches or timers; Save and Ctrl+S write with the read hash and persist', async ({ page }) => {
  const original = '# Note\n'
  const file = await scratchFile('claude', original)
  const puts: Array<{ body: Record<string, unknown> }> = []
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/api/file')) puts.push({ body: request.postDataJSON() }) })
  await openForEditing(page, file.url)
  const readHash = await page.getByTestId('document-view').getAttribute('data-hash')
  expect(readHash).toBe(sha256(original))

  await typeAtEnd(page, 'typed')
  await expect(saveStatus(page)).toHaveText('Unsaved')
  await page.getByRole('tab', { name: 'Preview' }).click()
  await page.getByRole('tab', { name: 'Edit' }).click()
  await page.waitForTimeout(1500)
  expect(puts).toHaveLength(0)
  expect(await readFile(file.path, 'utf8')).toBe(original)

  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(puts).toHaveLength(1)
  expect(puts[0].body).toEqual({ source: 'Claude', path: file.name, content: '# Note\ntyped', expectedHash: sha256(original) })
  expect(await readFile(file.path, 'utf8')).toBe('# Note\ntyped')
  await expect(page.getByRole('status')).toContainText(`Saved ${file.name}`)

  // Ctrl+S saves with the hash returned by the previous save and does not open the browser's save dialog.
  await typeAtEnd(page, ' again')
  await expect(saveStatus(page)).toHaveText('Unsaved')
  await page.evaluate(`window.__savePrevented = undefined; window.addEventListener('keydown', event => { if (event.key === 's') window.__savePrevented = event.defaultPrevented })`)
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate('window.__savePrevented')).toBe(true)
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(puts).toHaveLength(2)
  expect(puts[1].body.expectedHash).toBe(sha256('# Note\ntyped'))
  expect(await readFile(file.path, 'utf8')).toBe('# Note\ntyped again')

  // Ctrl+S while focus is on the Preview tab still saves (editing mode), and nothing is written when unchanged.
  await page.getByRole('tab', { name: 'Preview' }).click()
  await page.getByRole('tab', { name: 'Preview' }).focus()
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(300)
  expect(puts).toHaveLength(2)

  await page.reload()
  await expect(page.getByRole('tabpanel')).toContainText('typed again')
  expect(await page.getByTestId('document-view').getAttribute('data-hash')).toBe(sha256('# Note\ntyped again'))
})

type Held = { route: Route; body: Record<string, unknown> }

/** Holds every PUT so the test controls when and how each save settles. */
function holdSaves(page: Page) {
  const held: Held[] = []
  const waiters: Array<(held: Held) => void> = []
  let consumed = 0
  void page.route('**/api/file', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const entry = { route, body: route.request().postDataJSON() as Record<string, unknown> }
    held.push(entry)
    waiters.splice(0).forEach(resolve => resolve(entry))
  })
  return {
    held,
    /** The next request not yet handed out, waiting for it if necessary. */
    next: () => {
      const index = consumed
      consumed += 1
      return index < held.length ? Promise.resolve(held[index]) : new Promise<Held>(resolve => waiters.push(resolve))
    },
    count: () => held.length,
  }
}

test('one save in flight; later explicit saves replace one pending slot and use the returned hash; unsent edits stay Unsaved', async ({ page }) => {
  const file = await scratchFile('pi', 'base\n')
  const saves = holdSaves(page)
  await openForEditing(page, file.url)

  await typeAtEnd(page, '1')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saving')
  const first = await saves.next()
  expect(saves.count()).toBe(1)
  expect(first.body.content).toBe('base\n1')

  // Editor stays usable; a second and third explicit save only replace the pending snapshot.
  await typeAtEnd(page, '2')
  await saveButton(page).click()
  await typeAtEnd(page, '3')
  await saveButton(page).click()
  await typeAtEnd(page, '4')
  await page.waitForTimeout(300)
  expect(saves.count()).toBe(1)
  await expect(saveStatus(page)).toHaveText('Saving')

  // Release the first save with a server-chosen hash: the queued snapshot is sent with exactly that hash.
  const firstHash = 'a'.repeat(64)
  await first.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'Pi', path: file.name, hash: firstHash }) })
  const second = await saves.next()
  expect(saves.count()).toBe(2)
  expect(second.body).toEqual({ source: 'Pi', path: file.name, content: 'base\n123', expectedHash: firstHash })
  await expect(saveStatus(page)).toHaveText('Saving')

  const secondHash = 'b'.repeat(64)
  await second.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'Pi', path: file.name, hash: secondHash }) })
  // "4" was typed after the last explicit save: it is not saved and must not show Saved.
  await expect(saveStatus(page)).toHaveText('Unsaved')
  await page.waitForTimeout(300)
  expect(saves.count()).toBe(2)
  await expect(editor(page)).toContainText('base')
  expect(await editor(page).innerText()).toContain('1234')

  await saveButton(page).click()
  const third = await saves.next()
  expect(third.body).toEqual({ source: 'Pi', path: file.name, content: 'base\n1234', expectedHash: secondHash })
  await third.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'Pi', path: file.name, hash: 'c'.repeat(64) }) })
  await expect(saveStatus(page)).toHaveText('Saved')
})

test('a failed save stops the queue, keeps every edit, shows Error with Retry, and Retry uses the acknowledged hash', async ({ page }) => {
  const file = await scratchFile('pi', 'base\n')
  const saves = holdSaves(page)
  await openForEditing(page, file.url)
  await typeAtEnd(page, '1')
  await saveButton(page).click()
  await typeAtEnd(page, '2')
  await saveButton(page).click()
  await typeAtEnd(page, '3')
  const first = await saves.next()
  expect(saves.count()).toBe(1)
  await first.route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'WRITE_FAILED', error: 'The file could not be written.' }) })

  await expect(saveStatus(page)).toHaveText('Error')
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('could not be written')
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(alert.getByRole('button', { name: 'Copy draft' })).toBeVisible()
  await page.waitForTimeout(300)
  expect(saves.count()).toBe(1)
  expect(await editor(page).innerText()).toContain('123')
  expect(await readFile(file.path, 'utf8')).toBe('base\n')

  await alert.getByRole('button', { name: 'Retry' }).click()
  const retry = await saves.next()
  expect(retry.body).toEqual({ source: 'Pi', path: file.name, content: 'base\n123', expectedHash: sha256('base\n') })
  await retry.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'Pi', path: file.name, hash: sha256('base\n123') }) })
  await expect(saveStatus(page)).toHaveText('Saved')
  await expect(page.getByRole('alert')).toHaveCount(0)

  // An unreachable API is an ordinary failure with the same recovery.
  await typeAtEnd(page, '4')
  await saveButton(page).click()
  const dropped = await saves.next()
  await dropped.route.abort('connectionrefused')
  await expect(saveStatus(page)).toHaveText('Error')
  await expect(page.getByRole('alert')).toContainText('could not be reached')
  expect(await editor(page).innerText()).toContain('1234')
})

test('a response from an abandoned editing session cannot affect another document', async ({ page }) => {
  const first = await scratchFile('pi', 'first\n')
  const second = await scratchFile('pi', 'second\n')
  const saves = holdSaves(page)
  await page.goto('/Pi')
  await page.getByRole('button', { name: 'Outline' }).click()
  const outline = page.getByRole('navigation', { name: 'Directory outline' })
  await outline.getByRole('button', { name: new RegExp(`^${first.name}\\s*, Markdown file$`) }).click()
  await editButton(page).click()
  await typeAtEnd(page, ' edited')
  await saveButton(page).click()
  const held = await saves.next()
  await expect(saveStatus(page)).toHaveText('Saving')

  // Browser Back is not intercepted; it abandons the pending session.
  await page.goBack()
  await expect(page).toHaveURL('/Pi')
  await outline.getByRole('button', { name: new RegExp(`^${second.name}\\s*, Markdown file$`) }).click()
  await editButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  await typeAtEnd(page, ' two')
  await expect(saveStatus(page)).toHaveText('Unsaved')

  await held.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'Pi', path: first.name, hash: 'd'.repeat(64) }) })
  await page.waitForTimeout(300)
  await expect(saveStatus(page)).toHaveText('Unsaved')
  expect(await editor(page).innerText()).toContain(' two')
  await saveButton(page).click()
  const own = await saves.next()
  expect(own.body).toEqual({ source: 'Pi', path: second.name, content: 'second\n two', expectedHash: sha256('second\n') })
  await own.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'Pi', path: second.name, hash: sha256('second\n two') }) })
  await expect(saveStatus(page)).toHaveText('Saved')
  // Returning to the first document reads the disk: the abandoned draft is gone.
  await page.goto(first.url)
  await expect(page.getByRole('tabpanel')).toContainText('first')
  await expect(page.getByRole('tabpanel')).not.toContainText('edited')
})

test('unchanged CRLF, BOM and no-final-newline files round-trip byte for byte; edits keep the file line ending', async ({ page }) => {
  const cases: Array<[string, Buffer]> = [
    ['crlf', Buffer.from('# CRLF\r\n\r\nline two\r\n', 'utf8')],
    ['bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM\r\nno final newline', 'utf8')])],
    ['nofinal', Buffer.from('# No newline at end', 'utf8')],
    ['blank', Buffer.from('\n\n\n', 'utf8')],
  ]
  for (const [, bytes] of cases) {
    const file = await scratchFile('claude', bytes)
    await openForEditing(page, file.url)
    // Force a write of the unchanged text: type and delete one character.
    await typeAtEnd(page, 'x')
    await page.keyboard.press('Backspace')
    await expect(saveStatus(page)).toHaveText('Saved')
    await editor(page).click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.type('!')
    await page.keyboard.press('Backspace')
    await expect(saveStatus(page)).toHaveText('Saved')
    // The unchanged draft equals the acknowledged content, so Save sends nothing; force a real change and back.
    await typeAtEnd(page, 'Z')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('Saved')
    await editor(page).click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Backspace')
    await expect(saveStatus(page)).toHaveText('Unsaved')
    await saveButton(page).click()
    await expect(saveStatus(page)).toHaveText('Saved')
    expect((await readFile(file.path)).toString('hex'), JSON.stringify(bytes.toString('utf8'))).toBe(bytes.toString('hex'))
  }
  // An edited CRLF file keeps CRLF for new lines too.
  const crlf = await scratchFile('claude', 'one\r\ntwo\r\n')
  await openForEditing(page, crlf.url)
  await typeAtEnd(page, 'three\nfour')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await readFile(crlf.path, 'utf8')).toBe('one\r\ntwo\r\nthree\r\nfour')
})

test('files that cannot round-trip losslessly stay read-only with an explanation', async ({ page }) => {
  const mixed = await scratchFile('pi', 'one\r\ntwo\nthree')
  await page.goto(mixed.url)
  await expect(page.getByRole('tabpanel')).toContainText('one')
  await expect(editButton(page)).toBeDisabled()
  await expect(page.getByTestId('edit-unavailable')).toContainText('mixed line endings')

  const invalid = await scratchFile('pi', Buffer.from([0x23, 0x20, 0x68, 0x69, 0x0a, 0xff, 0xfe, 0x0a]))
  await page.goto(invalid.url)
  await expect(page.getByRole('tabpanel')).toContainText('hi')
  await expect(editButton(page)).toBeDisabled()
  await expect(page.getByTestId('edit-unavailable')).toContainText('not valid UTF-8')
  expect(await readFile(invalid.path)).toEqual(Buffer.from([0x23, 0x20, 0x68, 0x69, 0x0a, 0xff, 0xfe, 0x0a]))
})

test('the empty document can be edited and saved, and a document over 100 KB stays responsive while editing', async ({ page }) => {
  const empty = await scratchFile('claude', '')
  await openForEditing(page, empty.url)
  await expect(saveStatus(page)).toHaveText('Saved')
  await typeAtEnd(page, '# Was empty')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(await readFile(empty.path, 'utf8')).toBe('# Was empty')

  const large = await scratchFile('pi', `# Large\n${'A paragraph of text that repeats. '.repeat(4000)}\n`)
  const started = Date.now()
  await openForEditing(page, large.url)
  await typeAtEnd(page, 'end')
  await saveButton(page).click()
  await expect(saveStatus(page)).toHaveText('Saved')
  expect(Date.now() - started).toBeLessThan(6000)
  expect((await readFile(large.path, 'utf8')).endsWith('\nend')).toBe(true)
})
