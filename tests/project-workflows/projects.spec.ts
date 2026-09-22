import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { PI, currentCrumb, fileUrl, node, openGraph, roots, waitForApi } from '../helpers.ts'
import { verificationPhase } from './harness.ts'
import { installProjectMocks, mockResponse } from './mock.ts'
import {
  APPROVAL_MESSAGE,
  CURRENT_LABEL,
  EMPTY_PROJECT,
  EMPTY_WORKFLOW_ID,
  EMPTY_WORKFLOW_NAME,
  LOG_TEXT_PREFIX,
  PINNED_LABEL,
  PROJECT,
  REUSE_MESSAGE,
  RUN_AWAITING,
  RUN_BLOCKED,
  RUN_FAILED,
  RUN_LEGACY,
  RUN_SUCCEEDED,
  UI_ASSUMPTION,
  WORKFLOW_ID,
  WORKFLOW_NAME,
  runDetails,
} from './fixtures.ts'

const phase = verificationPhase()

const projectsUrl = '/projects'
const projectUrl = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`
const workflowUrl = (projectId: string, workflowId: string) => `${projectUrl(projectId)}/workflows/${encodeURIComponent(workflowId)}`
const runUrl = (runId: string, nodeId?: string) => `${workflowUrl(PROJECT.project_id, WORKFLOW_ID)}/runs/${encodeURIComponent(runId)}${nodeId ? `/nodes/${encodeURIComponent(nodeId)}` : ''}`
const apiRun = (runId: string) => `/api/projects/${PROJECT.project_id}/workflows/${WORKFLOW_ID}/runs/${runId}`

const rootsNav = (page: Page) => page.getByRole('navigation', { name: 'Roots' })
const workspace = (page: Page) => page.getByTestId('projects-workspace')
const graphNode = (page: Page, nodeId: string) => page.locator(`[data-testid="workflow-graph"] [data-graph-node="${nodeId}"]`)
const nodeListItem = (page: Page, nodeId: string) => page.locator(`[data-testid="run-node-list"] [data-node-id="${nodeId}"]`)
const nodeDetail = (page: Page) => page.getByTestId('node-detail')

/** No view action may launch, approve, retry, delete or edit a run: no such real controls exist (graph nodes are read-only selectors). */
async function expectNoExecutionControls(page: Page) {
  const controls = workspace(page).locator('button, input, select, textarea, [role="menuitem"]')
  await expect(controls.filter({ hasText: /approve|retry|launch|start|resume|delete|cancel|integrate|edit|save/i })).toHaveCount(0)
  await expect(page.locator('form')).toHaveCount(0)
}

async function attach(page: Page, testInfo: TestInfo, id: string) {
  const image = testInfo.outputPath(`${id}.png`)
  await page.screenshot({ path: image, fullPage: true })
  await testInfo.attach(`screenshot:${id}`, { path: image, contentType: 'image/png' })
}

async function waitForProjectsApi(request: APIRequestContext) {
  if (phase !== 'candidate') return
  await expect.poll(async () => (await request.get('/api/projects')).status(), { timeout: 30_000 }).toBe(200)
}

test.beforeEach(async ({ page, request }) => {
  await waitForApi(request)
  await waitForProjectsApi(request)
  if (phase === 'worker') await installProjectMocks(page)
})

test(`[scenario:projects-navigation] Pi and Claude remain usable and Projects opens registered projects (${phase})`, async ({ page }, testInfo) => {
  // The existing skills graph still loads at Home with only the two sources, and the roots strip offers Projects.
  await openGraph(page)
  await expect(rootsNav(page).getByRole('link')).toHaveText(['Pi', 'Claude', 'Projects'])
  await expect(page.locator('.graph-canvas .node')).toHaveCount(2)
  await expect(page.getByRole('toolbar', { name: 'File operations' })).toBeVisible()

  // Projects opens the registered project list without disturbing the skills domain.
  await rootsNav(page).getByRole('link', { name: 'Projects' }).click()
  await expect(page).toHaveURL(/\/projects$/)
  await expect(currentCrumb(page)).toHaveText('Projects')
  await expect(rootsNav(page).getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page')
  const list = page.getByTestId('projects-list')
  await expect(list.getByRole('link')).toContainText([PROJECT.name, EMPTY_PROJECT.name])
  await expect(page.getByTestId('projects-info')).toContainText('Read-only')
  await expect(page.getByRole('toolbar', { name: 'File operations' })).toHaveCount(0)
  await expect(page.locator('.graph-canvas')).toHaveCount(0)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'projects-navigation')

  // Pi and Claude roots are still one click away and still browse the real skills API.
  await rootsNav(page).getByRole('link', { name: 'Pi' }).click()
  await expect(page).toHaveURL(/\/browse\/Pi$/)
  await expect(currentCrumb(page)).toHaveText('Pi')
  await expect(node(page, `Pi/${PI}`)).toBeVisible()
  await rootsNav(page).getByRole('link', { name: 'Claude' }).click()
  await expect(currentCrumb(page)).toHaveText('Claude')
  await expect(node(page, 'Claude/claude-personal')).toBeVisible()

  // Browser history moves between the two domains without losing either view.
  await page.goBack()
  await expect(currentCrumb(page)).toHaveText('Pi')
  await page.goBack()
  await expect(currentCrumb(page)).toHaveText('Projects')
  await expect(list.getByRole('link')).toHaveCount(2)
  await page.goForward()
  await expect(currentCrumb(page)).toHaveText('Pi')
  await expect(node(page, 'Pi')).toBeVisible()

  // Documents still open, and the unsaved-edit guard still protects a dirty draft from leaving to Projects.
  const scratch = join(roots.piPersonal, `projects-nav-${randomUUID()}.md`)
  await writeFile(scratch, '# Scratch\n\nEditable.\n')
  try {
    await page.goto(fileUrl('Pi', PI, scratch.slice(roots.piPersonal.length + 1)))
    await expect(page.getByTestId('document-view').getByRole('heading', { level: 2 })).toContainText('projects-nav-')
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('draft')
    await rootsNav(page).getByRole('link', { name: 'Projects' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Discard changes?')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page).toHaveURL(/\/file\/Pi\//)
    await expect(page.locator('.cm-content')).toContainText('draft')
    await rootsNav(page).getByRole('link', { name: 'Projects' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click()
    await expect(currentCrumb(page)).toHaveText('Projects')
  } finally {
    await rm(scratch, { force: true })
  }
})

test(`[scenario:workflow-run-graph] Select a project, workflow and run and inspect the pinned graph (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectsUrl)
  await page.getByTestId('projects-list').getByRole('link', { name: PROJECT.name }).click()
  await expect(currentCrumb(page)).toHaveText(PROJECT.name)
  const workflows = page.getByTestId('workflows-list')
  await expect(workflows.getByRole('link')).toContainText([WORKFLOW_NAME, EMPTY_WORKFLOW_NAME])
  await workflows.getByRole('link', { name: new RegExp(`^${WORKFLOW_NAME}`) }).click()
  await expect(page).toHaveURL(new RegExp(`${workflowUrl(PROJECT.project_id, WORKFLOW_ID)}$`))
  await expect(currentCrumb(page)).toHaveText(WORKFLOW_NAME)

  // The run list carries each run's actual status, newest first; the current definition graph shows the latest labels.
  const runList = page.getByTestId('run-list')
  await expect(runList.locator('li')).toHaveCount(5)
  await expect(runList.locator(`[data-run-id="${RUN_SUCCEEDED}"]`)).toHaveAttribute('data-status', 'succeeded')
  await expect(runList.locator(`[data-run-id="${RUN_FAILED}"]`)).toHaveAttribute('data-status', 'failed')
  await expect(runList.locator(`[data-run-id="${RUN_AWAITING}"]`)).toHaveAttribute('data-status', 'awaiting_approval')
  await expect(runList.locator(`[data-run-id="${RUN_BLOCKED}"]`)).toHaveAttribute('data-status', 'failed')
  await expect(runList.locator(`[data-run-id="${RUN_LEGACY}"]`)).toHaveAttribute('data-status', 'succeeded')
  await expect(page.getByTestId('current-definition')).toContainText('9 nodes')
  await expect(page.getByRole('group', { name: `Current definition graph of ${WORKFLOW_NAME}` }).locator('[data-graph-node="verify_ui"]')).toHaveAttribute('aria-label', new RegExp(`^${CURRENT_LABEL}, verification`))

  // The succeeded run was started under an older definition and is rendered against that pinned graph.
  await runList.getByRole('link', { name: new RegExp(`^${RUN_SUCCEEDED}`) }).click()
  await expect(page).toHaveURL(new RegExp(`${runUrl(RUN_SUCCEEDED)}$`))
  const runView = page.getByTestId('run-view')
  await expect(runView).toHaveAttribute('data-run-status', 'succeeded')
  await expect(page.getByTestId('run-status')).toContainText('Succeeded')
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  await expect(graphNode(page, 'verify_ui')).toHaveAttribute('aria-label', new RegExp(`^${PINNED_LABEL.replace(/[()]/g, '\\$&')}, verification, succeeded, attempt 1`))
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node]')).toHaveCount(9)
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node][data-status="succeeded"]')).toHaveCount(9)
  await expect(page.locator('[data-testid="workflow-graph"] [data-edge-from="handoff"][data-edge-to="verify_ui"]')).toHaveCount(1)
  await expect(page.getByTestId('node-hint')).toBeVisible()

  // Keyboard: focus a graph node, move with arrows, open with Enter; the selection is reflected in the URL and list.
  await graphNode(page, 'launch_ui').focus()
  await page.keyboard.press('ArrowRight')
  await expect(graphNode(page, 'launch_adapter')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`${runUrl(RUN_SUCCEEDED, 'launch_adapter')}$`))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_adapter')
  await expect(nodeDetail(page).getByRole('heading', { level: 3 })).toContainText('Launch adapter worker')
  await expect(page.getByTestId('node-status-meaning')).toContainText('not workflow completion')
  await expect(nodeListItem(page, 'launch_adapter').getByRole('link')).toHaveAttribute('aria-current', 'page')
  await attach(page, testInfo, 'workflow-run-graph')

  // Back returns to the run without a selected node; a different run shows its own (current) definition.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`${runUrl(RUN_SUCCEEDED)}$`))
  await expect(page.getByTestId('node-hint')).toBeVisible()
  await page.goBack()
  await expect(currentCrumb(page)).toHaveText(WORKFLOW_NAME)
  await runList.getByRole('link', { name: new RegExp(`^${RUN_FAILED}`) }).click()
  await expect(runView).toHaveAttribute('data-run-status', 'failed')
  await expect(page.getByTestId('definition-current')).toBeVisible()
  await expect(graphNode(page, 'verify_ui')).toHaveAttribute('aria-label', new RegExp(`^${CURRENT_LABEL}, verification, succeeded`))
  await expect(graphNode(page, 'verify_adapter')).toHaveAttribute('data-status', 'failed')
  await expect(graphNode(page, 'integrate')).toHaveAttribute('data-status', 'pending')
  await expectNoExecutionControls(page)
})

test(`[scenario:run-evidence] Inspect worker checks, changed files, assumptions, logs and screenshot evidence (${phase})`, async ({ page, request }, testInfo) => {
  // Discover which nodes published results: from the explicit fixtures in worker mode, from the real adapter in candidate mode.
  type Snapshot = { snapshot: { nodes: { node_id: string; result_uri: string | null; attempt: number }[] } }
  type Result = { artifacts: { kind: string }[]; checks: unknown[] }
  const detail: Snapshot = phase === 'worker' ? runDetails[RUN_SUCCEEDED] : await (await request.get(apiRun(RUN_SUCCEEDED))).json()
  // Worker results only: the review node links to the review result, which carries no artifacts.
  const published = detail.snapshot.nodes.filter(node => node.result_uri !== null && node.result_uri.includes('/results/'))
  expect(published.length, 'the succeeded run must expose at least one node result').toBeGreaterThan(0)
  const results = await Promise.all(published.map(async node => ({
    node,
    result: (phase === 'worker' ? mockResponse(new URL(node.result_uri!, 'http://mock')) && JSON.parse(mockResponse(new URL(node.result_uri!, 'http://mock')).body as string) : await (await request.get(node.result_uri!)).json()) as Result,
  })))
  const withScreenshot = results.find(entry => entry.result.artifacts.some(artifact => artifact.kind === 'screenshot'))
  expect(withScreenshot, 'a node result must carry screenshot evidence').toBeTruthy()
  const target = withScreenshot!.node

  await page.goto(runUrl(RUN_SUCCEEDED))
  await nodeListItem(page, target.node_id).getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', target.node_id)
  await expect(page.getByTestId('node-attempt')).toHaveText(String(target.attempt))
  const result = page.getByTestId('worker-result')
  await expect(result).toBeVisible()
  await expect(page.getByTestId('worker-summary')).not.toBeEmpty()

  // Checks actually executed, with exit codes and their log artifacts loaded on demand.
  const checks = page.getByTestId('checks-list').locator('.check')
  await expect(checks).toHaveCount(withScreenshot!.result.checks.length)
  await expect(checks.first().locator('.check-exit')).toContainText('exit 0')
  await checks.first().getByRole('button', { name: 'Show contents' }).click()
  const log = checks.first().locator('[data-testid^="artifact-text:"]')
  await expect(log).toContainText(LOG_TEXT_PREFIX)
  await checks.first().getByRole('button', { name: 'Hide contents' }).click()
  await expect(log).toHaveCount(0)

  // Changed files, assumptions and screenshots come from the result, not from the viewer.
  await expect(page.getByTestId('changed-files').locator('li')).toContainText(['src/App.tsx'])
  await expect(page.getByTestId('assumptions').locator('li')).toContainText([UI_ASSUMPTION])
  const screenshot = page.getByTestId('screenshots').locator('img').first()
  await expect(screenshot).toBeVisible()
  await expect.poll(() => screenshot.evaluate(image => (image as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('node-events').or(page.getByTestId('events-none'))).toBeVisible()
  await expect(page.getByTestId('reuse-none').or(page.getByTestId('reuse-list'))).toBeVisible()
  await attach(page, testInfo, 'run-evidence')

  // Nodes without a result say so explicitly instead of showing another node's evidence.
  const unpublished = detail.snapshot.nodes.find(node => node.result_uri === null)
  if (unpublished) {
    await nodeListItem(page, unpublished.node_id).getByRole('link').click()
    await expect(page.getByTestId('result-none')).toBeVisible()
    await expect(page.getByTestId('worker-result')).toHaveCount(0)
  }

  // Explicit reuse evidence: the failed run reran only the adapter lane and reused the UI verification.
  await page.goto(runUrl(RUN_FAILED, 'verify_ui'))
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_ui')
  if (phase === 'worker') {
    await expect(page.getByTestId('reuse-list')).toContainText(REUSE_MESSAGE)
    await expect(page.getByTestId('reuse-list')).toContainText('Attempt 2 reused the result of attempt 1')
  } else {
    // The adapter decides how persisted evidence maps to reuse events; either explicit reuse or an explicit absence is shown.
    await expect(page.getByTestId('reuse-none').or(page.getByTestId('reuse-list'))).toBeVisible()
  }
  await expectNoExecutionControls(page)
})

test(`[scenario:empty-states] Distinguish no workflows from no runs (${phase})`, async ({ page }, testInfo) => {
  await page.goto(projectUrl(EMPTY_PROJECT.project_id))
  await expect(currentCrumb(page)).toHaveText(EMPTY_PROJECT.name)
  const emptyWorkflows = page.getByTestId('empty-workflows')
  await expect(emptyWorkflows).toContainText(`${EMPTY_PROJECT.name} has no workflow definitions`)
  await expect(page.getByTestId('workflows-list')).toHaveCount(0)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  const noWorkflowsText = await emptyWorkflows.innerText()

  await page.goto(workflowUrl(PROJECT.project_id, EMPTY_WORKFLOW_ID))
  await expect(currentCrumb(page)).toHaveText(EMPTY_WORKFLOW_NAME)
  const emptyRuns = page.getByTestId('empty-runs')
  await expect(emptyRuns).toContainText('No runs have been recorded for this workflow')
  await expect(page.getByTestId('run-list')).toHaveCount(0)
  // The workflow itself exists: its current definition is still shown next to the empty run list.
  await expect(page.getByTestId('current-definition')).toContainText('3 nodes')
  await expect(page.getByRole('group', { name: `Current definition graph of ${EMPTY_WORKFLOW_NAME}` })).toBeVisible()
  expect(await emptyRuns.innerText()).not.toEqual(noWorkflowsText)
  await attach(page, testInfo, 'empty-states')

  // The populated project and workflow show lists, never an empty state.
  await page.goto(projectUrl(PROJECT.project_id))
  await expect(page.getByTestId('workflows-list')).toBeVisible()
  await expect(page.getByTestId('empty-workflows')).toHaveCount(0)
})

test(`[scenario:failed-and-paused] Show failure and awaiting-approval state without implying completion (${phase})`, async ({ page }, testInfo) => {
  // A narrow viewport must still give a usable single-column layout with no horizontal overflow.
  await page.setViewportSize({ width: 420, height: 900 })

  await page.goto(runUrl(RUN_FAILED, 'verify_adapter'))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'failed')
  await expect(page.getByTestId('run-status')).toContainText('Failed')
  await expect(page.getByTestId('run-status-meaning')).toContainText('did not complete')
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_adapter')
  await expect(nodeDetail(page).locator('.status-badge').first()).toHaveText('Failed')
  await expect(page.getByTestId('node-status-meaning')).toContainText('This step failed')
  await expect(page.getByTestId('node-attempt')).toHaveText('1')
  // Downstream nodes have not started: attempt 0, pending, no session, no result.
  await expect(nodeListItem(page, 'candidate')).toHaveAttribute('data-status', 'pending')
  await nodeListItem(page, 'integrate').getByRole('link').click()
  await expect(page.getByTestId('node-attempt')).toHaveText('0 (not started)')
  await expect(page.getByTestId('result-none')).toBeVisible()
  if (phase === 'worker') {
    await page.goto(runUrl(RUN_FAILED, 'verify_adapter'))
    await expect(page.getByTestId('worker-error')).toContainText('injected_gate_failure')
    await expect(page.getByTestId('worker-error')).toContainText('Retrying is done through the workflow CLI')
  }

  await page.goto(runUrl(RUN_AWAITING, 'review'))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'awaiting_approval')
  await expect(page.getByTestId('run-status')).toContainText('Awaiting approval')
  await expect(page.getByTestId('run-status-meaning')).toContainText('not complete')
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(page.getByTestId('awaiting-notice')).toContainText('Viewing does not approve it')
  if (phase === 'worker') await expect(page.getByTestId('awaiting-notice')).toContainText(APPROVAL_MESSAGE)
  await expect(graphNode(page, 'review')).toHaveAttribute('data-status', 'awaiting_approval')
  await expect(graphNode(page, 'approval')).toHaveAttribute('data-status', 'pending')
  await expect(graphNode(page, 'integrate')).toHaveAttribute('data-status', 'pending')
  // The launch nodes finished, and the viewer says what that does (not) mean.
  await nodeListItem(page, 'launch_ui').getByRole('link').click()
  await expect(page.getByTestId('node-status-meaning')).toContainText('This is not workflow completion')
  await expect(page.getByTestId('run-status')).toContainText('Awaiting approval')
  await expectNoExecutionControls(page)
  const overflow = await page.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })') as { scroll: number; inner: number }
  expect(overflow.scroll, 'narrow layout must not overflow horizontally').toBeLessThanOrEqual(overflow.inner)
  await attach(page, testInfo, 'failed-and-paused')
})

test(`[scenario:request-errors] Show an actionable API error rather than silently substituting fixtures (${phase})`, async ({ page }, testInfo) => {
  // A server failure on the project list: the error is shown with its code and status, and no project appears.
  let failProjects = true
  await page.route(url => url.pathname === '/api/projects', async route => {
    if (failProjects) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'registry_unavailable', message: 'The project registry could not be read.' } }) })
    else await route.fallback()
  })
  await page.goto(projectsUrl)
  const error = page.getByTestId('projects-error')
  await expect(error).toContainText('The project list could not be loaded')
  await expect(error).toContainText('The project registry could not be read.')
  await expect(error).toContainText('registry_unavailable')
  await expect(error).toContainText('HTTP 503')
  await expect(error).toHaveAttribute('data-error-kind', 'http')
  await expect(page.getByTestId('projects-list')).toHaveCount(0)
  await expect(page.getByText(PROJECT.name)).toHaveCount(0)
  await attach(page, testInfo, 'request-errors')
  failProjects = false
  await error.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('projects-list').getByRole('link')).toContainText([PROJECT.name])

  // An unreachable API for the workflows of a project.
  let dropWorkflows = true
  await page.route(url => url.pathname === `/api/projects/${PROJECT.project_id}/workflows`, async route => {
    if (dropWorkflows) await route.abort('connectionrefused')
    else await route.fallback()
  })
  await page.goto(projectUrl(PROJECT.project_id))
  await expect(page.getByTestId('projects-error')).toContainText('could not be reached')
  await expect(page.getByTestId('projects-error')).toHaveAttribute('data-error-kind', 'network')
  await expect(page.getByTestId('workflows-list')).toHaveCount(0)
  dropWorkflows = false
  await page.getByTestId('projects-error').getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('workflows-list')).toBeVisible()

  // A payload that violates the contract is rejected, not rendered.
  let corruptRuns = true
  await page.route(url => url.pathname === `/api/projects/${PROJECT.project_id}/workflows/${WORKFLOW_ID}/runs`, async route => {
    if (corruptRuns) await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [{ run_id: 'bogus' }], next_cursor: null }) })
    else await route.fallback()
  })
  await page.goto(workflowUrl(PROJECT.project_id, WORKFLOW_ID))
  await expect(page.getByTestId('projects-error')).toContainText('does not match the projects contract')
  await expect(page.getByTestId('projects-error')).toHaveAttribute('data-error-kind', 'malformed')
  await expect(page.getByTestId('run-list')).toHaveCount(0)
  corruptRuns = false
  await page.getByTestId('projects-error').getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('run-list')).toBeVisible()

  // Not found, served by this phase's API: an unregistered project, and a run requested under the wrong project.
  await page.goto(projectUrl('nope-project'))
  await expect(page.getByTestId('not-found')).toContainText('“nope-project” is not registered')
  await page.getByTestId('not-found').getByRole('link', { name: 'Go to Projects' }).click()
  await expect(currentCrumb(page)).toHaveText('Projects')
  await page.goto(`${workflowUrl(EMPTY_PROJECT.project_id, WORKFLOW_ID)}/runs/${RUN_SUCCEEDED}`)
  await expect(page.getByTestId('not-found')).toContainText(`“${RUN_SUCCEEDED}” was not found`)
  await expect(page.getByTestId('run-view')).toHaveCount(0)
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')

  // A malformed Projects link is explained, not guessed.
  await page.goto('/projects/alpha-project/not-workflows/x')
  await expect(page.getByRole('alert')).toContainText('This Projects link is invalid')
  await expect(page.getByTestId('run-view')).toHaveCount(0)
})
