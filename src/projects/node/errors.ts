/**
 * What an API failure says about the project it came from. Pure (no React), so the error panel and the unit tests read the
 * same values.
 */

/** The error code the server answers (503) when a workflow's configured run storage cannot be opened. */
export const RUNS_ROOT_UNAVAILABLE = 'RUNS_ROOT_UNAVAILABLE'

/**
 * The project id a failed request was for, parsed from its path (`/api/projects/<encoded id>/…`, a query or fragment
 * ignored) and decoded; null for a path outside the project routes or one whose segment does not decode.
 */
export function projectIdFromPath(path: string): string | null {
  const match = /^\/api\/projects\/([^/?#]+)/.exec(path)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}
