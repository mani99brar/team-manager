import { useState, type MouseEvent } from 'react'
import { breadcrumbsFor, breadcrumbsForFile, folderToPathname, type FileRef, type FolderRef } from './model.ts'

type Props = {
  selected: FolderRef | null
  /** When set, the trail leads to the file's folder and ends with the filename as a non-navigating item. */
  file?: FileRef | null
  onNavigate: (ref: FolderRef | null) => void
}

const MAX_VISIBLE = 4

/** Home / Source / folder … trail. Long trails collapse the middle behind an expandable “…” control. */
export function Breadcrumbs({ selected, file = null, onNavigate }: Props) {
  const [showAll, setShowAll] = useState(false)
  const crumbs = file ? breadcrumbsForFile(file) : breadcrumbsFor(selected)
  const collapsed = !showAll && crumbs.length > MAX_VISIBLE
  const hidden = collapsed ? crumbs.slice(1, crumbs.length - 2) : []
  const visible = collapsed ? [crumbs[0], ...crumbs.slice(crumbs.length - 2)] : crumbs

  const follow = (ref: FolderRef | null) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    onNavigate(ref)
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
              {crumb.ref === undefined ? (
                <span className="breadcrumb-current" aria-current="page">{crumb.label}</span>
              ) : (
                <a href={folderToPathname(crumb.ref)} aria-current={isCurrent ? 'page' : undefined} onClick={follow(crumb.ref)}>
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
