import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Props = { content: string }

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
    return (
      <span role="img" className="image-unavailable" aria-label={`${label} (image unavailable: only HTTPS images are shown)`}>
        {label} (image unavailable)
      </span>
    )
  },
  table(all) {
    return <div className="table-wrap"><table {...domProps(all)} /></div>
  },
}

/** GitHub-flavored rendering with react-markdown defaults: raw HTML stays literal text, unsafe URLs are dropped. */
export const Markdown = memo(function Markdown({ content }: Props) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </div>
  )
})
