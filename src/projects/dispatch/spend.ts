import type { ProjectSpend } from './types.ts'

/**
 * The project header's spend figure, from the dispatch overview's `spend` (the Claude totals its runs' exports record): "$<x>
 * Claude spend · <k> of <n> runs priced" with x to the cent, "no Claude spend recorded" when no run is priced, and nothing
 * (null) while the overview is unread or the spend is null or absent. Never a covered estimate, never a run page's Spent.
 */
export function spendFigure(spend: ProjectSpend | null | undefined): string | null {
  if (spend === null || spend === undefined) return null
  if (spend.priced_runs === 0 || spend.claude_usd === null) return 'no Claude spend recorded'
  return `$${spend.claude_usd.toFixed(2)} Claude spend · ${spend.priced_runs} of ${spend.runs} runs priced`
}
