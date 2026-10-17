/**
 * The GitHub view's pure model (docs/PRD_RUN_TEAMS.md 4 "GitHub view"). Pure: no React, no DOM, no `.tsx` import. The
 * scaffold holds only a provisional switcher suffix; the GitHub view lane replaces it with one derived from
 * `githubSituation` (section 4.2) and adds the cards' view-models here.
 */
import type { RunGithub } from '../../../contracts/projects/github.ts'
import { pushTone, type Suffix } from '../tone.ts'

/**
 * PROVISIONAL (the GitHub lane replaces it with the section 4.2 situation table): the pull request's number when there is
 * one, else the branch's push word, untoned; `reading` before the first read; none when the read is not served (null).
 */
export function githubSuffix(runGithub: RunGithub | null): Suffix | null {
  if (runGithub === null) return null
  if (runGithub.github.status === 'pending') return { tone: null, word: 'reading', spoken: 'reading GitHub' }
  if (runGithub.pr !== null) return { tone: null, word: `#${runGithub.pr.number}`, spoken: `pull request ${runGithub.pr.number}` }
  const { word } = pushTone(runGithub.branch.push_state)
  return { tone: null, word, spoken: `branch ${word}` }
}
