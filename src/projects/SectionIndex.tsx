import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { sectionId, type SectionEntry } from './node/model.ts'

/**
 * One section of a node page (docs/PRD_VIEWER_UX.md 4.4, 10): a `<section aria-labelledby>` the index links to. It names
 * itself with its own `<h4>`, or with the heading of the panel it holds (`labelledBy`) when that panel brings one.
 */
export function NodeSection({ sectionKey, title, labelledBy, className, testId, children }: {
  sectionKey: string
  title?: ReactNode
  labelledBy?: string
  className?: string
  testId?: string
  children: ReactNode
}) {
  const id = sectionId(sectionKey)
  return (
    <section id={id} className={`node-section${className ? ` ${className}` : ''}`} aria-labelledby={labelledBy ?? `${id}-title`} data-section={sectionKey} data-testid={testId}>
      {labelledBy === undefined && <h4 id={`${id}-title`} className="node-section-title">{title}</h4>}
      {children}
    </section>
  )
}

/**
 * The section index of a node page (docs/PRD_VIEWER_UX.md 4.4): in-page links to its sections with their counts. Only
 * sections with something in them are listed, History last; `children` follow the index on its row (the link to the
 * worker's report). It sticks under the step strip once the page scrolls, and a link scrolls its section into view and
 * moves the focus to its heading without touching the path.
 */
export function SectionIndex({ label, sections, children }: { label: string; sections: SectionEntry[]; children?: ReactNode }) {
  const row = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  // Sticks right under the step strip, whose height depends on how many lanes it stacks.
  useLayoutEffect(() => {
    const strip = row.current?.closest('.run-body')?.querySelector<HTMLElement>('.step-strip')
    if (!strip) return
    const measure = () => setTop(strip.offsetHeight)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [])
  const open = (key: string) => {
    const target = document.getElementById(sectionId(key))
    if (!target) return
    // Below the sticky strip and index, which would otherwise cover the section's heading.
    const covered = top + (row.current?.offsetHeight ?? 0) + 8
    window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - covered))
    const heading = target.querySelector<HTMLElement>('h4, h5')
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
      heading.focus({ preventScroll: true })
    }
  }
  return (
    <div ref={row} className="section-index" style={{ top }}>
      <nav aria-label={`Sections of ${label}`} data-testid="section-index">
        <ul className="section-index-list">
          {sections.map(section => (
            <li key={section.key}>
              <a
                href={`#${sectionId(section.key)}`}
                className="section-index-link"
                data-section={section.key}
                data-count={section.count}
                onClick={event => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                  event.preventDefault()
                  open(section.key)
                }}
              >
                {section.label}
                {section.count !== undefined && <>{' '}<span className="section-index-count">{section.count}</span></>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </div>
  )
}
