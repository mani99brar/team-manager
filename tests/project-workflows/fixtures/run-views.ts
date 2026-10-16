/**
 * The run views switcher's fixtures (docs/PRD_RUN_TEAMS.md 2 "Views and routing", scenarios `run-views-switcher` and
 * `run-views-phone`): one minimal teams payload and one run GitHub read on the core run `run-succeeded`, so the switcher shows
 * a Team suffix ("1 running · 1 failed") and a GitHub suffix in the worker phase. Worker-phase payloads only: the candidate
 * phase serves whatever the real server reads, and the switcher spec asserts the suffixes in the worker phase only. The Team
 * and GitHub view lanes add their own fixture modules.
 */
import { runGithub as exampleRunGithub, teams as exampleTeams } from '../../../contracts/projects/teamExamples.ts'
import { PROJECT, RUN_SUCCEEDED, WORKFLOW_ID } from '../fixtures.ts'
import type { UxFixtureModule } from './index.ts'

export const RUN_VIEWS_RUN = RUN_SUCCEEDED

export const uxRunViews: UxFixtureModule = {
  payloads: {
    teams: { [RUN_VIEWS_RUN]: { ...exampleTeams, run_id: RUN_VIEWS_RUN } },
    runGithub: { [RUN_VIEWS_RUN]: { ...exampleRunGithub, project_id: PROJECT.project_id, workflow_id: WORKFLOW_ID, run_id: RUN_VIEWS_RUN } },
  },
}
