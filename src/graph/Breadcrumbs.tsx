import { useState, type MouseEvent } from 'react'
import { breadcrumbsFor, breadcrumbsForFile, folderToPathname, type FileRef, type FolderRef, type TreeIndex } from './model.ts'

/** A crumb of a non-skills trail (the Projects root): a pathname to navigate to, or the current item without one. */
export type PathCrumb = { id: string; label: string; pathname?: string }

type Props = {
  selected: FolderRef | null
  /** When set, the trail leads to the file's folder and ends with the filename as a non-navigating item. */
  file?: FileRef | null
  /** Supplies location labels; while the listing is loading the location id is shown instead. */
  index: TreeIndex | null
  onNavigate: (ref: FolderRef | null) => void
  /** Replaces the skills trail with an arbitrary pathname trail (used by the Projects root). */
  custom?: { crumbs: PathCrumb[]; onNavigate: (pathname: string) => void }
}

type Item = { id: string; label: string; href: string | null; follow: (() => void) | null }

/** Home / source / location / folder / current fits; deeper trails collapse the middle. */
const MAX_VISIBLE = 5

/** Home / Source / Location / folder … trail. Long trails collapse the middle behind an expandable “…” control. */
export function Breadcrumbs({ selected, file = null, index, onNavigate, custom }: Props) {
  const [showAll, setShowAll] = useState(false)
  const items: Item[] = custom
    ? custom.crumbs.map(crumb => ({
        id: crumb.id,
        label: crumb.label,
        href: crumb.pathname ?? null,
        follow: crumb.pathname === undefined ? null : () => custom.onNavigate(crumb.pathname!),
      }))
    : (file ? breadcrumbsForFile(file, index) : breadcrumbsFor(selected, index)).map(crumb => ({
        id: crumb.id,
        label: crumb.label,
        href: crumb.ref === undefined ? null : folderToPathname(crumb.ref),
        follow: crumb.ref === undefined ? null : () => onNavigate(crumb.ref ?? null),
      }))
  const collapsed = !showAll && items.length > MAX_VISIBLE
  const hidden = collapsed ? items.slice(1, items.length - 2) : []
  const visible = collapsed ? [items[0], ...items.slice(items.length - 2)] : items

  const follow = (action: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    action()
  }

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {visible.map((crumb, position) => {
          const isCurrent = position === visible.length - 1
          return (
            <li key={crumb.id}>
              {position === 1 && hidden.length > 0 && (
                <>
                  <button
                    type="button"
                    className="breadcrumb-ellipsis"
                    aria-expanded={false}
                    aria-label={`Show ${hidden.length} hidden breadcrumb ${hidden.length === 1 ? 'level' : 'levels'}`}
                    onClick={() => setShowAll(true)}
                  >
                    …
                  </button>
                  <span className="breadcrumb-separator" aria-hidden="true">/</span>
                </>
              )}
              {crumb.href === null || crumb.follow === null ? (
                <span className="breadcrumb-current" aria-current="page">{crumb.label}</span>
              ) : (
                <a href={crumb.href} aria-current={isCurrent ? 'page' : undefined} onClick={follow(crumb.follow)}>
                  {crumb.label}
                </a>
              )}
              {!isCurrent && <span className="breadcrumb-separator" aria-hidden="true">/</span>}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
