import { test, expect } from '@playwright/test'

test('real app lists all five files with source-relative paths', async ({ page, request }) => {
  await expect.poll(async () => (await request.get('http://127.0.0.1:3001/api/files')).status()).toBe(200)
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('5 Markdown files')
  const rows = page.locator('tbody tr')
  await expect(rows).toHaveCount(5)
  const expected = [
    ['Pi', 'skills/review.md'], ['Pi', 'workflow.md'],
    ['Claude', 'empty.md'], ['Claude', 'subagents/implementer.md'], ['Claude', 'workflow.md'],
  ]
  for (const [index, cells] of expected.entries()) {
    await expect(rows.nth(index).locator('td')).toHaveText(cells)
  }
  await expect(page.getByText('notes.txt')).toHaveCount(0)
})

test('loading then empty state', async ({ page }) => {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/files', async route => {
    await wait
    await route.fulfill({ json: { files: [] } })
  })
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Loading Markdown files…')
  release()
  await expect(page.getByRole('status')).toHaveText('No Markdown files found in the Pi or Claude fixture folders.')
  await expect(page.getByRole('table')).toHaveCount(0)
})

for (const failure of ['http', 'network']) {
  test(`${failure} error gives recovery guidance`, async ({ page }) => {
    await page.route('**/api/files', route => failure === 'http'
      ? route.fulfill({ status: 500, json: { error: 'Listing failed' } })
      : route.abort())
    await page.goto('/')
    await expect(page.getByRole('alert')).toContainText('Unable to load Markdown files.')
    await expect(page.getByRole('alert')).toContainText('reload the page')
    await expect(page.getByRole('table')).toHaveCount(0)
  })
}
