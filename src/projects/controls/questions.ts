import type { Now } from '../../../contracts/projects/triage.ts'
import type { RunInputs } from '../api.ts'

export type WaitingQuestion = { n: number | null; text: string }

/**
 * The question each lane waits on, for the Answer dialog: the export's latest unanswered question per lane, then what the
 * live Now says (a question asked since the export), which names its lane and quotes the text. Appendix A's control
 * carries only the lane choices, so the dialog reads the question from the page.
 */
export function waitingQuestions(now: Now | null, inputs: RunInputs | null): Record<string, WaitingQuestion> {
  const found: Record<string, WaitingQuestion> = {}
  for (const worker of inputs?.workers ?? []) {
    const latest = worker.questions.at(-1)
    if (latest && latest.answer === null) found[worker.node_id] = { n: latest.n, text: latest.question }
  }
  if (now?.situation === 'question' && now.lane && now.reason) {
    const quoted = /“([\s\S]*)”/.exec(now.reason.filter((part): part is string => typeof part === 'string').join(''))
    if (quoted && !now.lane.includes(',')) found[now.lane] = { n: found[now.lane]?.n ?? null, text: quoted[1] }
  }
  return found
}
