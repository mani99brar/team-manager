import { test, expect, type Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CLAUDE, PI, fileUrl, roots, waitForApi } from './helpers.ts'

/**
 * Rendering tests use uniquely named scratch files under the personal Pi location root that are removed in
 * afterEach, even on failure. Documents are opened by direct link, so no listing refresh is needed.
 */
const created: string[] = []

async function scratchFile(name: string, content: string): Promise<{ path: string; url: string }> {
  const folder = `scratch-render-${randomUUID().slice(0, 8)}`
  const directory = join(roots.piPersonal, folder)
  created.push(directory)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, name), content)
  const path = `${folder}/${name}`
  return { path, url: fileUrl('Pi', PI, path) }
}

// A 1×1 transparent PNG, served for intercepted HTTPS image requests.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test.beforeEach(async ({ request }) => { await waitForApi(request) })

test.afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true })
})

function tabs(page: Page) {
  return {
    rendered: page.getByRole('tab', { name: 'Rendered' }),
    source: page.getByRole('tab', { name: 'Source' }),
    panel: page.getByRole('tabpanel'),
    sourceText: () => page.getByTestId('document-source').evaluate(element => element.textContent),
  }
}

async function openDocument(page: Page, url: string) {
  await page.goto(url)
  await expect(page.getByTestId('document-view').locator('header').getByRole('heading', { level: 2 })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true')
}

test('GFM: tables, task lists, strikethrough, autolinks and fenced code render; Source is exact', async ({ page }) => {
  const content = [
    '# Title',
    '',
    'Intro with ~~struck~~ text and https://example.com/auto autolink.',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| alpha | 1 |',
    '| beta | 2 |',
    '',
    '- [x] done item',
    '- [ ] open item',
    '',
    '1. first',
    '2. second',
    '',
    '```ts',
    'const answer = 42',
    '  return answer',
    '```',
    '',
    '> quoted',
    '',
  ].join('\n')
  const file = await scratchFile('gfm.md', content)
  await openDocument(page, file.url)
  const { rendered, source, panel, sourceText } = tabs(page)

  await expect(panel.getByRole('heading', { level: 1, name: 'Title' })).toBeVisible()
  await expect(panel.locator('del')).toHaveText('struck')
  await expect(panel.getByRole('link', { name: 'https://example.com/auto' })).toHaveAttribute('href', 'https://example.com/auto')
  await expect(panel.getByRole('table')).toBeVisible()
  await expect(panel.getByRole('columnheader', { name: 'Value' })).toBeVisible()
  await expect(panel.getByRole('cell', { name: 'beta' })).toBeVisible()
  const checkboxes = panel.getByRole('checkbox')
  await expect(checkboxes).toHaveCount(2)
  await expect(checkboxes.nth(0)).toBeChecked()
  await expect(checkboxes.nth(1)).not.toBeChecked()
  await expect(checkboxes.nth(0)).toBeDisabled()
  await expect(panel.getByRole('listitem').filter({ hasText: 'second' })).toBeVisible()
  await expect(panel.locator('pre code')).toHaveText('const answer = 42\n  return answer\n')
  await expect(panel.locator('blockquote')).toHaveText('quoted')
  // The Markdown is rendered, not shown as text.
  await expect(panel).not.toContainText('| ---')
  await expect(panel).not.toContainText('```')

  // Switching tabs neither refetches nor changes the document identity.
  const fileRequests: string[] = []
  page.on('request', request => { if (request.url().includes('/api/file')) fileRequests.push(request.url()) })
  await source.click()
  await expect(source).toHaveAttribute('aria-selected', 'true')
  await expect(rendered).toHaveAttribute('aria-selected', 'false')
  expect(await sourceText()).toBe(content)
  await expect(page).toHaveURL(file.url)
  await rendered.click()
  await expect(rendered).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('table')).toBeVisible()
  expect(fileRequests).toEqual([])
})

test('Source preserves leading/trailing whitespace, CRLF, tabs and frontmatter exactly', async ({ page }) => {
  const content = '\n\n---\r\nname: keep-me\r\n---\r\n\t# Not a heading because of the tab\r\n   \r\ntrailing spaces   \r\n\r\n\r\n'
  const file = await scratchFile('exact.md', content)
  await openDocument(page, file.url)
  const { source, sourceText, panel } = tabs(page)
  await source.click()
  expect(await sourceText()).toBe(content)
  await expect(panel).not.toContainText('This file is empty')
})

test('an empty file shows an explicit message and an exactly empty Source', async ({ page }) => {
  const file = await scratchFile('empty.md', '')
  await openDocument(page, file.url)
  const { source, sourceText, panel } = tabs(page)
  await expect(panel).toContainText('This file is empty')
  await expect(page.getByTestId('document-source')).toHaveCount(0)
  await source.click()
  await expect(panel).toContainText('This file is empty')
  expect(await sourceText()).toBe('')

  // The seeded empty file behaves the same way.
  await openDocument(page, fileUrl('Claude', CLAUDE, 'empty.md'))
  await expect(page.getByRole('tabpanel')).toContainText('This file is empty')
})

test('tabs are keyboard operable with a roving tab stop and expose selection state', async ({ page }) => {
  const file = await scratchFile('tabs.md', '# Tabs\n\nBody text.\n')
  await openDocument(page, file.url)
  const { rendered, source, panel } = tabs(page)
  await expect(page.getByRole('tablist', { name: 'Document view' })).toBeVisible()
  await expect(rendered).toHaveAttribute('tabindex', '0')
  await expect(source).toHaveAttribute('tabindex', '-1')

  await rendered.focus()
  await page.keyboard.press('ArrowRight')
  await expect(source).toBeFocused()
  await expect(source).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('document-source')).toBeVisible()
  await expect(panel).toHaveAttribute('aria-labelledby', await source.getAttribute('id') ?? '')
  await expect(panel.getByRole('heading', { name: 'Tabs', exact: true })).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(rendered).toBeFocused()
  await expect(rendered).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('heading', { name: 'Tabs', exact: true })).toBeVisible()
  await page.keyboard.press('End')
  await expect(source).toBeFocused()
  await page.keyboard.press('Home')
  await expect(rendered).toBeFocused()
  // Only the selected tab is in the Tab order; Tab leaves the tablist.
  await page.keyboard.press('Tab')
  await expect(source).not.toBeFocused()
  await expect(rendered).not.toBeFocused()

  // Enter/Space on a tab also select it (native button semantics).
  await source.focus()
  await page.keyboard.press('Enter')
  await expect(source).toHaveAttribute('aria-selected', 'true')
})

test('links: external links open in a new tab with noopener; relative and unsafe links are inert', async ({ page }) => {
  const content = [
    'External: [Example](https://example.com/page) and [Plain](http://example.com/plain).',
    '',
    'Relative: [Other](./other.md) and [Sibling](../workflow.md) and [Anchor](#title).',
    '',
    'Unsafe: [Evil](javascript:window.__pwned=1) and [Data](data:text/html,hi).',
    '',
  ].join('\n')
  const file = await scratchFile('links.md', content)
  await openDocument(page, file.url)
  const panel = page.getByRole('tabpanel')

  const external = panel.getByRole('link', { name: 'Example' })
  await expect(external).toHaveAttribute('href', 'https://example.com/page')
  await expect(external).toHaveAttribute('target', '_blank')
  await expect(external).toHaveAttribute('rel', /\bnoopener\b/)
  await expect(panel.getByRole('link', { name: 'Plain' })).toHaveAttribute('target', '_blank')

  // Relative document links are visible text but not links, and activating them does nothing.
  const requests: string[] = []
  page.on('request', request => requests.push(request.url()))
  for (const name of ['Other', 'Sibling', 'Anchor', 'Evil', 'Data']) {
    await expect(panel.getByRole('link', { name })).toHaveCount(0)
    await expect(panel.getByText(name, { exact: true })).toBeVisible()
    await panel.getByText(name, { exact: true }).click()
    await expect(page).toHaveURL(file.url)
  }
  expect(requests.filter(url => url.includes('/api/') || url.includes('other.md') || url.includes('workflow.md'))).toEqual([])
  expect(await page.evaluate('window.__pwned')).toBeUndefined()
  await expect(page.getByTestId('document-view').locator('header').getByRole('heading', { level: 2 })).toHaveText('links.md')
})

test('images: HTTPS images load; relative images show an accessible unavailable state without fetching', async ({ page }) => {
  const imageRequests: string[] = []
  await page.route('https://images.example/**', route => {
    imageRequests.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  const content = [
    '![Remote diagram](https://images.example/pic.png)',
    '',
    '![Local diagram](./assets/pic.png)',
    '',
    '![Rooted diagram](/assets/rooted.png)',
    '',
  ].join('\n')
  const file = await scratchFile('images.md', content)
  const requests: string[] = []
  page.on('request', request => { if (request.resourceType() === 'image') requests.push(request.url()) })
  await openDocument(page, file.url)
  const panel = page.getByRole('tabpanel')

  const remote = panel.getByRole('img', { name: 'Remote diagram' })
  await expect(remote).toBeVisible()
  await expect(remote).toHaveAttribute('src', 'https://images.example/pic.png')
  await expect.poll(() => remote.evaluate(element => (element as unknown as { naturalWidth: number }).naturalWidth)).toBe(1)
  expect(imageRequests).toEqual(['https://images.example/pic.png'])

  for (const name of ['Local diagram', 'Rooted diagram']) {
    const unavailable = panel.getByRole('img', { name: new RegExp(`^${name}.*unavailable`) })
    await expect(unavailable).toBeVisible()
    await expect(unavailable).not.toHaveAttribute('src', /.+/)
  }
  // The only image request is the remote one; relative images are never resolved against the app.
  expect(requests).toEqual(['https://images.example/pic.png'])
})

test('raw HTML is shown as literal text and never interpreted or executed', async ({ page }) => {
  const content = [
    '# Raw',
    '',
    '<div id="raw-element" class="raw">block element</div>',
    '',
    'Inline <span id="raw-inline">span</span> text.',
    '',
    '<img src="x" onerror="window.__xss = 1">',
    '',
    '<script>window.__xss = 2</script>',
    '',
    '<a href="javascript:window.__xss = 3">raw link</a>',
    '',
  ].join('\n')
  const file = await scratchFile('raw-html.md', content)
  await openDocument(page, file.url)
  const panel = page.getByRole('tabpanel')

  await expect(panel).toContainText('<div id="raw-element" class="raw">block element</div>')
  await expect(panel).toContainText('<span id="raw-inline">span</span>')
  await expect(panel).toContainText('<img src="x" onerror="window.__xss = 1">')
  await expect(panel).toContainText('<script>window.__xss = 2</script>')
  await expect(panel).toContainText('<a href="javascript:window.__xss = 3">raw link</a>')
  await expect(panel.locator('#raw-element')).toHaveCount(0)
  await expect(panel.locator('#raw-inline')).toHaveCount(0)
  await expect(panel.locator('img')).toHaveCount(0)
  await expect(panel.locator('script')).toHaveCount(0)
  await expect(panel.getByRole('link')).toHaveCount(0)
  expect(await page.evaluate('window.__xss')).toBeUndefined()
})

test('narrow screens and dark mode: wide tables and code scroll inside the document, not the page', async ({ page }) => {
  const content = [
    '# Narrow',
    '',
    '| ' + Array.from({ length: 8 }, (_, i) => `column-${i}-with-a-long-name`).join(' | ') + ' |',
    '| ' + Array.from({ length: 8 }, () => '---').join(' | ') + ' |',
    '| ' + Array.from({ length: 8 }, (_, i) => `value-${i}`).join(' | ') + ' |',
    '',
    '```',
    'a-very-long-unbroken-line-of-code-' + 'x'.repeat(200),
    '```',
    '',
    'averyveryverylongunbrokenword' + 'y'.repeat(120),
    '',
  ].join('\n')
  const file = await scratchFile('narrow.md', content)
  await page.setViewportSize({ width: 360, height: 640 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await openDocument(page, file.url)
  for (const name of ['Refresh', 'Back to folder']) await expect(page.getByRole('button', { name })).toBeInViewport()
  await expect(page.getByRole('tab', { name: 'Source' })).toBeInViewport()
  const overflow = () => page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  expect(await overflow()).toBeLessThanOrEqual(0)
  await page.getByRole('tab', { name: 'Source' }).click()
  await expect(page.getByTestId('document-source')).toBeVisible()
  expect(await overflow()).toBeLessThanOrEqual(0)
  // Dark theme applies to the document surfaces (not the light default).
  const sourceBackground = () => page.evaluate("getComputedStyle(document.querySelector('[data-testid=document-source]')).backgroundColor")
  const background = await sourceBackground()
  expect(background).toBe('rgb(38, 46, 55)')
  await page.emulateMedia({ colorScheme: 'light' })
  const lightBackground = await sourceBackground()
  expect(lightBackground).toBe('rgb(236, 239, 243)')
})
