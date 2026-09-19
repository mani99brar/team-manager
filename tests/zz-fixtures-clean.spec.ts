import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Runs last (files execute alphabetically on the single worker): the suite must leave fixtures/ untouched.
test('the suite leaves no modified or untracked files under fixtures/', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url))
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'fixtures'], { cwd: repo, encoding: 'utf8' })
  expect(status.trim()).toBe('')
})
