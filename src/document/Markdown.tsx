import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = {
  content: string
  /**
   * Opt-in for Markdown that comes from run data (captured files, tasks, decisions): no image is fetched and no link is
   * live, so rendering it never contacts another host. The default (false) keeps the document viewer's policy below.
   */
  inert?: boolean
}

const EXTERNAL_LINK = /^https?:\/\//i
const REMOTE_IMAGE = /^https:\/\//i

/**
 * Rendering policy on top of react-markdown's defaults (raw HTML stays literal text; unsafe URL schemes
 * such as javascript: are already stripped by the default URL transform):
 * - http(s) links open in a new tab with noopener.
 * - Every other link (relative documents, anchors, stripped unsafe URLs) is inert text.
 * - Only https images are loaded, and they contact the remote server. Anything else shows an
 *   accessible unavailable state and is never resolved against the app or an asset route.
 */
/** react-markdown passes the hast node alongside DOM props; it must not reach the DOM. */
function domProps<T extends { node?: unknown }>(props: T): Omit<T, 'node'> {
  const rest: T = { ...props }
  delete rest.node
  return rest
}

function unavailableImage(label: string, reason: string) {
  return (
    <span role="img" className="image-unavailable" aria-label={`${label} (image unavailable: ${reason})`}>
      {label} (image unavailable)
    </span>
  )
}

const table: Components['table'] = all => <div className="table-wrap"><table {...domProps(all)} /></div>

const components: Components = {
  a(all) {
    const { href, children, ...props } = domProps(all)
    if (href && EXTERNAL_LINK.test(href)) {
      return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    }
    return <span {...props} className="link-inert" title="This link is not followed in the viewer">{children}</span>
  },
  img(all) {
    const { src, alt, ...props } = domProps(all)
    const label = alt || 'Image'
    if (src && REMOTE_IMAGE.test(src)) return <img {...props} src={src} alt={alt ?? ''} loading="lazy" />
    return unavailableImage(label, 'only HTTPS images are shown')
  },
  table,
}

/**
 * The inert policy: every link is text followed by its target as text, and every image is a labelled placeholder
 * naming its source, so nothing is fetched and nothing navigates.
 */
const inertComponents: Components = {
  a(all) {
    const { href, children, title } = domProps(all)
    return (
      <span className="link-inert" data-inert-link={href ?? ''} title={title ?? 'Links in run data are not followed in the viewer'}>
        {children}
        {href ? <span className="link-inert-target"> ({href})</span> : null}
      </span>
    )
  },
  img(all) {
    const { src, alt } = domProps(all)
    const label = alt || 'Image'
    return (
      <span data-inert-image={src ?? ''}>
        {unavailableImage(label, 'images in run data are not loaded')}
        {src ? <span className="link-inert-target"> ({src})</span> : null}
      </span>
    )
  },
  table,
}

/** GitHub-flavored rendering with react-markdown defaults: raw HTML stays literal text, unsafe URLs are dropped. */
export const Markdown = memo(function Markdown({ content, inert = false }: Props) {
  return (
    <div className="markdown" data-inert={inert ? 'true' : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={inert ? inertComponents : components}>{content}</ReactMarkdown>
    </div>
  )
})
