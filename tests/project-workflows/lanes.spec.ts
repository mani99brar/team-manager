/**
 * Worker lanes from configuration (PRD_WORKER_LANES section 6, viewer half): the viewer shows the lanes a run
 * actually had. `viewer-three-lanes` drives the `lanes-flow` runs exported at 1.3.0; `legacy-run` re-reads the
 * unchanged 1.2.0 two-lane export of `feature-flow` and pins down that it still renders as it did.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  DOCS_COMPLETION_SUMMARY,
  DOCS_QUOTE,
  DOCS_SESSION,
  FEATURE_NAME,
  GRAPH_NODES,
  LANES_FEATURE_NAME,
  LANES_WORKFLOW_ID,
  LANES_WORKFLOW_NAME,
  ONE_LANE_NODES,
  PINNED_LABEL,
  PROJECT,
  RUN_LEGACY,
  RUN_ONE_LANE,
  RUN_SUCCEEDED,
  RUN_THREE_LANES,
  THREE_LANES,
  THREE_LANE_NODES,
  WORKFLOW_ID,
  WORKFLOW_NAME,
  reviewFindings,
} from './fixtures.ts'
import { attach, expectNoExecutionControls, graphNode, installHooks, nodeDetail, nodeListItem, openTask, phase, renderedText, runUrl, workflowUrl } from './support.ts'

installHooks()

const lanesRunUrl = (runId: string, nodeId?: string) => runUrl(runId, nodeId, LANES_WORKFLOW_ID)
const graphNodes = (page: Page) => page.locator('[data-testid="workflow-graph"] [data-graph-node]')
const edge = (page: Page, from: string, to: string) => page.locator(`[data-testid="workflow-graph"] [data-edge-from="${from}"][data-edge-to="${to}"]`)
const findings = (page: Page) => page.getByTestId('review-findings')
const findingRows = (page: Page) => findings(page).getByTestId('finding')
const workerGroup = (page: Page, key: string) => findings(page).locator(`section[data-worker-group="${key}"]`)
const workerColumn = (row: Locator) => row.locator('td').nth(2)
const assignmentWorker = (page: Page, lane: string) => page.locator(`[data-testid="assignment-worker"][data-worker="${lane}"]`)
const attributeList = (locator: Locator, attribute: string) => locator.evaluateAll((elements, name) => elements.map(element => element.getAttribute(name)), attribute)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test(`[scenario:viewer-three-lanes] A three-lane run shows three launch and verify nodes, three workers and findings grouped by lane (${phase})`, async ({ page }, testInfo) => {
  // The lanes workflow is listed beside the two-lane one and holds its own runs.
  await page.goto(workflowUrl(PROJECT.project_id, LANES_WORKFLOW_ID))
  await expect(page.getByTestId('current-definition')).toContainText(`${THREE_LANE_NODES.length} nodes`)
  const runList = page.getByTestId('run-list')
  await expect(runList.locator('li')).toHaveCount(2)
  await expect(runList.locator(`[data-run-id="${RUN_THREE_LANES}"]`)).toHaveAttribute('data-status', 'succeeded')
  await expect(runList.locator(`[data-run-id="${RUN_ONE_LANE}"]`)).toHaveAttribute('data-status', 'succeeded')

  // The pinned graph has a launch and a verify node per lane, in policy order, wired through the handoff and the candidate.
  await runList.getByRole('link', { name: new RegExp(`^${RUN_THREE_LANES}`) }).click()
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(page.getByTestId('definition-current')).toBeVisible()
  await expect(graphNodes(page)).toHaveCount(THREE_LANE_NODES.length)
  expect(await attributeList(graphNodes(page), 'data-graph-node')).toEqual(THREE_LANE_NODES.map(node => node.node_id))
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node][data-status="succeeded"]')).toHaveCount(THREE_LANE_NODES.length)
  for (const lane of THREE_LANES) {
    await expect(graphNode(page, `launch_${lane}`)).toHaveAttribute('aria-label', new RegExp(`^Launch ${lane} worker, worker, succeeded, attempt 1`))
    await expect(graphNode(page, `verify_${lane}`)).toHaveAttribute('aria-label', new RegExp(`^Verify ${lane}, verification, succeeded, attempt 1`))
    await expect(edge(page, `launch_${lane}`, 'handoff')).toHaveCount(1)
    await expect(edge(page, 'handoff', `verify_${lane}`)).toHaveCount(1)
    await expect(edge(page, `verify_${lane}`, 'candidate')).toHaveCount(1)
  }
  await expect(page.getByTestId('run-node-list').locator('[data-node-id]')).toHaveCount(THREE_LANE_NODES.length)
  await expect(page.getByTestId('run-inputs-facts')).toContainText(LANES_FEATURE_NAME)

  // The Assignment tab lists the three workers in policy order, with the lane selection and each lane's required check kinds.
  await page.getByTestId('tab-assignment').click()
  const workers = page.getByTestId('assignment-worker')
  await expect(workers).toHaveCount(3)
  expect(await attributeList(workers, 'data-worker')).toEqual([...THREE_LANES])
  await expect(page.getByTestId('assignment-selected-workers')).toHaveText(THREE_LANES.join(', '))
  await expect(page.getByTestId('assignment-excluded-workers')).toHaveCount(0)
  await expect(page.getByTestId('assignment-lanes')).toContainText('3 worker lanes in this run')
  const docs = assignmentWorker(page, 'docs')
  const docsHeading = docs.getByRole('heading', { level: 4 })
  await expect(docsHeading).toContainText('Worker docs (writer)')
  await expect(docsHeading.getByRole('link')).toHaveAttribute('href', lanesRunUrl(RUN_THREE_LANES, 'launch_docs'))
  await expect(docs.getByTestId('assignment-task').getByRole('heading', { name: 'Docs worker' })).toBeVisible()
  await expect(docs.getByTestId('assignment-task').getByRole('listitem')).toContainText([DOCS_QUOTE])
  await expect(docs).toContainText('docs/links.test.ts')
  await expect(docs.getByTestId('assignment-required-kinds')).toHaveText('Required check kinds: unit')
  await expect(assignmentWorker(page, 'ui').getByTestId('assignment-required-kinds')).toHaveText('Required check kinds: build, browser')
  await expect(assignmentWorker(page, 'adapter').getByTestId('assignment-required-kinds')).toHaveText('Required check kinds: unit')
  await expect(assignmentWorker(page, 'ui').getByRole('heading', { level: 4 })).toContainText('Worker ui (frontend)')
  await renderedText(page.getByTestId('assignment'))

  // The docs lane's launch node shows its own task, receipt and completion; its verify node shows its own evidence.
  await docsHeading.getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_docs')
  await expect(nodeDetail(page).getByRole('heading', { level: 3 })).toContainText('Launch docs worker')
  await expect(page.getByTestId('worker-inputs-unmatched')).toHaveCount(0)
  await openTask(page)
  await expect(page.getByTestId('task-panel').getByRole('heading', { name: 'Docs worker' })).toBeVisible()
  await expect(page.getByTestId('task-required-kinds')).toHaveText('Required check kinds for this lane: unit')
  await expect(page.getByTestId('task-checks').locator('[data-check-id="docs-unit"]')).toContainText('exit 0')
  await expect(page.getByTestId('launch-receipt')).toContainText(DOCS_SESSION)
  await expect(page.getByTestId('worker-completion')).toContainText(DOCS_COMPLETION_SUMMARY)
  await expect(page.getByTestId('worker-stop')).toContainText('Stop confirmed')
  await expect(page.getByTestId('changed-files').locator('li')).toContainText(['docs/PRD_WORKER_LANES.md'])
  await nodeListItem(page, 'verify_docs').getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'verify_docs')
  await expect(page.getByTestId('worker-result')).toBeVisible()
  await expect(page.getByTestId('checks-list').locator('.check')).toHaveCount(1)
  await expect(page.getByTestId('projects-error')).toHaveCount(0)

  // Findings group by the run's lanes in policy order, then "multiple workers" (including a legacy `both`) and "none".
  await nodeListItem(page, 'review').getByRole('link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'review')
  await expect(page.getByTestId('review-verdict')).toHaveText('Approved')
  await expect(page.getByTestId('review-reviewer')).toContainText('independent of every worker lane')
  await expect(findingRows(page)).toHaveCount(6)
  for (const finding of reviewFindings(RUN_THREE_LANES)) await expect(findings(page)).toContainText(finding.message)
  await page.getByTestId('group-by-worker').click()
  await expect(findings(page)).toHaveAttribute('data-group-by', 'worker')
  const groups = findings(page).locator('section[data-worker-group]')
  await expect(groups).toHaveCount(5)
  expect(await attributeList(groups, 'data-worker-group')).toEqual([...THREE_LANES, 'multiple', 'none'])
  for (const lane of THREE_LANES) {
    await expect(workerGroup(page, lane).getByRole('heading')).toHaveText(`Worker ${lane} (1)`)
    await expect(workerColumn(workerGroup(page, lane).getByTestId('finding'))).toHaveText(lane)
  }
  await expect(workerGroup(page, 'multiple').getByRole('heading')).toHaveText('Multiple workers (2)')
  const legacy = workerGroup(page, 'multiple').getByTestId('finding').filter({ hasText: 'Both lanes duplicate' })
  await expect(legacy).toHaveAttribute('data-worker', 'both')
  await expect(workerColumn(legacy)).toHaveText('multiple workers')
  const multiple = workerGroup(page, 'multiple').getByTestId('finding').filter({ hasText: 'name the same check id' })
  await expect(multiple).toHaveAttribute('data-worker', 'multiple')
  await expect(workerColumn(multiple)).toHaveText('multiple workers')
  await expect(workerGroup(page, 'none').getByRole('heading')).toHaveText('No worker (cross-cutting) (1)')
  await expect(workerColumn(workerGroup(page, 'none').getByTestId('finding'))).toHaveText('none')
  await expect(findings(page)).not.toContainText('Both workers')
  await expect(findings(page)).toContainText(`Workers are the lanes this run had (${THREE_LANES.join(', ')})`)
  await expect(findingRows(page)).toHaveCount(6)

  // Each quoted requirement links to the lane whose task contains it, including the docs lane, and highlights there.
  await expect(page.getByTestId('finding-task-link')).toHaveCount(3)
  for (const lane of THREE_LANES) {
    await expect(page.locator(`[data-testid="finding-task-link"][data-lane="${lane}"]`)).toHaveAttribute('href', lanesRunUrl(RUN_THREE_LANES, `launch_${lane}`))
  }
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'viewer-three-lanes')
  await workerGroup(page, 'docs').getByTestId('finding-task-link').click()
  await expect(nodeDetail(page)).toHaveAttribute('data-node-id', 'launch_docs')
  await expect(page.getByTestId('task-highlight')).toHaveText(DOCS_QUOTE)

  // A run that selected one lane pins a one-lane graph, names the excluded lanes and groups findings by that lane only.
  await page.goto(lanesRunUrl(RUN_ONE_LANE))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  await expect(graphNodes(page)).toHaveCount(ONE_LANE_NODES.length)
  expect(await attributeList(graphNodes(page), 'data-graph-node')).toEqual(ONE_LANE_NODES.map(node => node.node_id))
  await expect(graphNode(page, 'launch_docs')).toHaveAttribute('data-status', 'succeeded')
  await expect(edge(page, 'launch_docs', 'handoff')).toHaveCount(1)
  await expect(edge(page, 'verify_docs', 'candidate')).toHaveCount(1)
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node][data-status="succeeded"]')).toHaveCount(ONE_LANE_NODES.length)
  await page.getByTestId('tab-assignment').click()
  await expect(page.getByTestId('assignment-worker')).toHaveCount(1)
  await expect(assignmentWorker(page, 'docs')).toBeVisible()
  await expect(page.getByTestId('assignment-selected-workers')).toHaveText('docs')
  await expect(page.getByTestId('assignment-lanes')).toContainText('1 worker lane in this run')
  await expect(page.getByTestId('assignment-excluded-workers')).toHaveText('ui, adapter')
  await page.goto(lanesRunUrl(RUN_ONE_LANE, 'review'))
  await expect(findingRows(page)).toHaveCount(2)
  await page.getByTestId('group-by-worker').click()
  expect(await attributeList(findings(page).locator('section[data-worker-group]'), 'data-worker-group')).toEqual(['docs', 'none'])
  await expect(workerGroup(page, 'docs').getByTestId('finding-task-link')).toHaveAttribute('href', lanesRunUrl(RUN_ONE_LANE, 'launch_docs'))
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expectNoExecutionControls(page)
})

test(`[scenario:legacy-run] A stored 1.2.0 two-lane export renders as before without re-export (${phase})`, async ({ page }, testInfo) => {
  // The two-lane workflow still lists exactly its own five runs; the lanes workflow is a separate entry.
  await page.goto(workflowUrl(PROJECT.project_id, WORKFLOW_ID))
  await expect(page.getByTestId('run-list').locator('li')).toHaveCount(5)
  await expect(page.getByTestId('run-list').locator(`[data-run-id="${RUN_THREE_LANES}"]`)).toHaveCount(0)
  await expect(page.getByTestId('current-definition')).toContainText(`${GRAPH_NODES.length} nodes`)
  await page.goto(`/projects/${PROJECT.project_id}`)
  await expect(page.getByTestId('workflows-list').getByRole('link')).toContainText([WORKFLOW_NAME, LANES_WORKFLOW_NAME])

  // The pinned two-lane graph: the same nine nodes with their stored labels, no third lane anywhere.
  await page.goto(runUrl(RUN_SUCCEEDED))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(graphNodes(page)).toHaveCount(GRAPH_NODES.length)
  expect(await attributeList(graphNodes(page), 'data-graph-node')).toEqual(GRAPH_NODES.map(node => node.node_id))
  await expect(graphNode(page, 'launch_ui')).toHaveAttribute('aria-label', /^Launch UI worker, worker, succeeded, attempt 1/)
  await expect(graphNode(page, 'launch_adapter')).toHaveAttribute('aria-label', /^Launch adapter worker, worker, succeeded, attempt 1/)
  await expect(graphNode(page, 'verify_ui')).toHaveAttribute('aria-label', new RegExp(`^${escape(PINNED_LABEL)}, verification, succeeded, attempt 1`))
  await expect(graphNode(page, 'verify_adapter')).toHaveAttribute('aria-label', /^Verify adapter, verification, succeeded, attempt 1/)
  await expect(page.locator('[data-testid="workflow-graph"] [data-graph-node][data-status="succeeded"]')).toHaveCount(GRAPH_NODES.length)
  await expect(page.getByTestId('definition-changed')).toBeVisible()
  await expect(page.getByTestId('run-inputs-facts')).toContainText(FEATURE_NAME)
  await expect(page.getByTestId('inputs-none')).toHaveCount(0)

  // The Assignment tab: the two recorded workers, both selected and nothing excluded, with the role-derived check kinds.
  await page.getByTestId('tab-assignment').click()
  const workers = page.getByTestId('assignment-worker')
  await expect(workers).toHaveCount(2)
  expect(await attributeList(workers, 'data-worker')).toEqual(['ui', 'adapter'])
  await expect(page.getByTestId('assignment-selected-workers')).toHaveText('ui, adapter')
  await expect(page.getByTestId('assignment-excluded-workers')).toHaveCount(0)
  await expect(assignmentWorker(page, 'ui').getByRole('heading', { level: 4 })).toContainText('Worker ui (frontend)')
  await expect(assignmentWorker(page, 'ui').getByRole('heading', { level: 4 }).getByRole('link')).toHaveAttribute('href', runUrl(RUN_SUCCEEDED, 'launch_ui'))
  await expect(assignmentWorker(page, 'ui').getByTestId('assignment-required-kinds')).toHaveText('Required check kinds: build, browser')
  await expect(assignmentWorker(page, 'adapter').getByRole('heading', { level: 4 })).toContainText('Worker adapter (backend)')
  await expect(assignmentWorker(page, 'adapter').getByTestId('assignment-required-kinds')).toHaveText('Required check kinds: unit')
  await expect(page.getByTestId('assignment')).not.toContainText('docs')

  // A worker node still matches its recorded lane by its launch node.
  await page.goto(runUrl(RUN_SUCCEEDED, 'launch_adapter'))
  await openTask(page)
  await expect(page.getByTestId('task-panel').getByRole('heading', { name: 'Adapter worker' })).toBeVisible()
  await expect(page.getByTestId('task-required-kinds')).toHaveText('Required check kinds for this lane: unit')
  await expect(page.getByTestId('worker-inputs-unmatched')).toHaveCount(0)

  // The recorded review: the same six findings, grouped by the two lanes; the stored `both` reads as "multiple workers".
  await page.goto(runUrl(RUN_SUCCEEDED, 'review'))
  await expect(page.getByTestId('review-verdict')).toHaveText('Approved')
  await expect(page.getByTestId('review-summary')).toHaveText('approved with 6 findings: 4 open, 2 accepted, none blocking')
  await expect(findingRows(page)).toHaveCount(6)
  for (const finding of reviewFindings(RUN_SUCCEEDED)) await expect(findings(page)).toContainText(finding.message)
  await page.getByTestId('group-by-worker').click()
  const groups = findings(page).locator('section[data-worker-group]')
  await expect(groups).toHaveCount(4)
  expect(await attributeList(groups, 'data-worker-group')).toEqual(['ui', 'adapter', 'multiple', 'none'])
  await expect(workerGroup(page, 'ui').getByRole('heading')).toHaveText('Worker ui (3)')
  await expect(workerGroup(page, 'adapter').getByRole('heading')).toHaveText('Worker adapter (1)')
  await expect(workerGroup(page, 'multiple').getByRole('heading')).toHaveText('Multiple workers (1)')
  await expect(workerGroup(page, 'none').getByRole('heading')).toHaveText('No worker (cross-cutting) (1)')
  const legacy = workerGroup(page, 'multiple').getByTestId('finding')
  await expect(legacy).toHaveAttribute('data-worker', 'both')
  await expect(workerColumn(legacy)).toHaveText('multiple workers')
  await expect(workerColumn(workerGroup(page, 'ui').getByTestId('finding').first())).toHaveText('ui')
  await expect(findings(page)).not.toContainText('Both workers')
  await expect(findings(page)).toContainText('Workers are the lanes this run had (ui, adapter)')
  await expect(page.getByTestId('finding-task-link')).toHaveCount(3)
  await expect(page.locator('[data-testid="finding-task-link"][data-lane="ui"]')).toHaveCount(2)
  await expect(page.locator('[data-testid="finding-task-link"][data-lane="adapter"]')).toHaveAttribute('href', runUrl(RUN_SUCCEEDED, 'launch_adapter'))
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
  await expect(page.getByTestId('result-unscoped')).toHaveCount(0)
  await expectNoExecutionControls(page)
  await attach(page, testInfo, 'legacy-run')

  // The 1.0.0 export without sections still renders its graph and says what is not recorded, without an error.
  await page.goto(runUrl(RUN_LEGACY, 'review'))
  await expect(page.getByTestId('run-view')).toHaveAttribute('data-run-status', 'succeeded')
  await expect(graphNodes(page)).toHaveCount(GRAPH_NODES.length)
  await expect(page.getByTestId('inputs-none')).toBeVisible()
  await expect(page.getByTestId('review-none')).toBeVisible()
  await expect(page.getByTestId('projects-error')).toHaveCount(0)
})
