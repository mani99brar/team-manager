import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { childCounts, childrenOf, describeCounts, SOURCES, type GraphNode, type TreeIndex } from './model.ts'

type Props = {
  index: TreeIndex
  expanded: ReadonlySet<string>
  selectedId: string | null
  /** Scroll position survives unmounting (graph mode, document view) through this owner-held store. */
  scrollRef: MutableRefObject<number>
  onSelect: (node: GraphNode) => void
  onOpenFile: (node: GraphNode) => void
  onToggleExpand: (node: GraphNode) => void
}

/** Accessible replacement for the graph: the same tree, expansion state and selection as nested lists. */
export function Outline({ index, expanded, selectedId, scrollRef, onSelect, onOpenFile, onToggleExpand }: Props) {
  const container = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (container.current) container.current.scrollTop = scrollRef.current
  }, [scrollRef])

  function renderFolder(node: GraphNode) {
    const isExpanded = expanded.has(node.id)
    const counts = childCounts(index, node.id)
    const children = childrenOf(index, node.id)
    return (
      <li key={node.id} className={`outline-item outline-${node.kind}`} data-node-id={node.id}>
        <div className="outline-row">
          <button
            type="button"
            className="outline-toggle"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => onToggleExpand(node)}
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <path d={isExpanded ? 'M 1 3 L 5 7 L 9 3' : 'M 3 1 L 7 5 L 3 9'} />
            </svg>
          </button>
          <button
            type="button"
            className="outline-name"
            aria-current={node.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(node)}
          >
            <span className="outline-icon" aria-hidden="true">{node.kind === 'source' ? '◎' : '▰'}</span>
            <span>{node.name}</span>
            <span className="visually-hidden">, {node.kind === 'source' ? 'source folder' : 'folder'}</span>
          </button>
          <span className="outline-counts">{describeCounts(counts)}</span>
        </div>
        {isExpanded && (
          <ul className="outline-list">
            {children.length === 0
              ? <li className="outline-empty">This folder is empty.</li>
              : children.map(child => (child.kind === 'file' ? renderFile(child) : renderFolder(child)))}
          </ul>
        )}
      </li>
    )
  }

  function renderFile(node: GraphNode) {
    return (
      <li key={node.id} className="outline-item outline-file" data-node-id={node.id}>
        <div className="outline-row">
          <button type="button" className="outline-name outline-file-name" onClick={() => onOpenFile(node)}>
            <span className="outline-icon" aria-hidden="true">▤</span>
            <span>{node.name}</span>
            <span className="visually-hidden">, Markdown file</span>
          </button>
        </div>
      </li>
    )
  }

  return (
    <nav
      className="outline"
      aria-label="Directory outline"
      ref={container}
      onScroll={event => { scrollRef.current = event.currentTarget.scrollTop }}
    >
      <ul className="outline-list outline-root">
        {SOURCES.map(source => renderFolder(index.nodes.get(source)!))}
      </ul>
    </nav>
  )
}
