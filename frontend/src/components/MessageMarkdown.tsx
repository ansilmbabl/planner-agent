import { useCallback, useRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const linkClass =
  'text-violet-400/95 underline decoration-violet-500/30 underline-offset-2 hover:decoration-violet-400/80'

type MessageMarkdownProps = {
  text: string
  /** Slightly different vertical rhythm; panel is for side column */
  size?: 'message' | 'panel'
  /** When true, render a single pre-wrapped string (e.g. errors) */
  plain?: boolean
  className?: string
}

/** LLMs often wrap the whole document in ```markdown fences; strip so tables/lists render. */
function normalizePanelMarkdown(raw: string): string {
  let t = String(raw || '').replace(/\r\n/g, '\n')
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i)
    if (m) {
      t = m[1]!.trim()
      continue
    }
    break
  }
  return t
}

function extractTextFromPre(node: ReactNode): string {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(extractTextFromPre).join('')
  }
  if (typeof node === 'object' && 'props' in (node as object)) {
    const p = (node as { props?: { children?: ReactNode } }).props
    if (p?.children != null) return extractTextFromPre(p.children)
  }
  return ''
}

function PreWithCopy({ children }: { children?: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const copy = useCallback(async () => {
    const el = preRef.current
    const t = el?.textContent?.trim() ?? extractTextFromPre(children)
    if (!t) return
    try {
      await navigator.clipboard.writeText(t)
    } catch {
      // ignore
    }
  }, [children])

  return (
    <div className="my-2 relative group/pre rounded-lg border border-slate-600/50 bg-slate-950/90 overflow-x-auto">
      <pre
        ref={preRef}
        className="!m-0 p-3 text-[12px] leading-relaxed text-slate-200 font-mono overflow-x-auto"
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-1.5 right-1.5 rounded-md border border-white/10 bg-slate-900/90 px-2 py-0.5 text-[10px] text-slate-400 opacity-0 pointer-events-none transition-opacity group-hover/pre:opacity-100 group-hover/pre:pointer-events-auto hover:text-slate-100 hover:border-white/20"
        aria-label="Copy code"
      >
        Copy
      </button>
    </div>
  )
}

export function MessageMarkdown({
  text,
  size = 'message',
  plain = false,
  className = '',
}: MessageMarkdownProps) {
  if (text == null || !String(text).trim()) {
    return null
  }

  if (plain) {
    return (
      <p
        className={`text-slate-200/95 mt-1.5 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}
      >
        {text}
      </p>
    )
  }

  const sizeClass =
    size === 'message' ? 'prose-chat prose-chat--message' : 'prose-chat prose-chat--panel'

  const markdownSource = size === 'panel' ? normalizePanelMarkdown(text) : text

  return (
    <div className={`${sizeClass} mt-1.5 ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) =>
            href ? (
              <a
                href={href}
                className={linkClass}
                target="_blank"
                rel="noreferrer noopener"
                {...props}
              >
                {children}
              </a>
            ) : (
              <span className="text-slate-300">{children}</span>
            ),
          pre: (props) => <PreWithCopy>{props.children}</PreWithCopy>,
          code: ({ className: codeClass, children, ...props }) => {
            // Fenced blocks use class "language-…" (incl. empty language label)
            const isBlock = Boolean(
              codeClass && /language-/i.test(String(codeClass))
            )
            if (isBlock) {
              return (
                <code className={codeClass} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code
                className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[0.9em] text-violet-200/95 font-mono [overflow-wrap:anywhere]"
                {...props}
              >
                {children}
              </code>
            )
          },
          table: ({ children, ...rest }) => (
            <div className="my-2 overflow-x-auto rounded-lg border border-slate-600/40">
              <table
                className="w-full min-w-[12rem] border-collapse text-left text-[12px] text-slate-200/95"
                {...rest}
              >
                {children}
              </table>
            </div>
          ),
          th: (props) => (
            <th
              className="border-b border-slate-600/60 bg-slate-900/80 px-2 py-1.5 font-medium text-slate-100"
              {...props}
            />
          ),
          td: (props) => <td className="border-b border-slate-700/50 px-2 py-1.5" {...props} />,
        }}
      >
        {markdownSource}
      </ReactMarkdown>
    </div>
  )
}
