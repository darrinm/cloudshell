import { memo, useRef, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark as oneDarkOriginal } from 'react-syntax-highlighter/dist/esm/styles/prism'

// Remove background from oneDark so code blocks inherit the parent bg
const oneDarkNoBg = Object.fromEntries(
  Object.entries(oneDarkOriginal).map(([key, value]) => {
    if (key === 'pre[class*="language-"]' || key === 'code[class*="language-"]') {
      const { background, backgroundColor, ...rest } = value as Record<string, string>
      return [key, rest]
    }
    return [key, value]
  })
)
import 'github-markdown-css/github-markdown-dark.css'

// Parallel sub-task tracking block
export interface SubTaskBlock {
  type: 'sub_task_group'
  tasks: SubTaskInfo[]
}

export interface SubTaskInfo {
  taskId: string
  prompt: string
  model: string
  status: 'running' | 'complete' | 'error'
  step: number
  currentTool: string
  toolsUsed: string[]
  toolCallCount: number
  summary?: string
  error?: string
}

// Content block types
export type ContentBlock =
  | { type: 'text'; content: string; resolvedContent?: string }
  | { type: 'image'; imageId: string; url: string }
  | { type: 'file'; fileId: string; filename: string; size: number; mimeType: string; url?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; result?: unknown; progress?: string; duration?: number; nestedTools?: Array<{ name: string; elapsed?: number }>; subagentSummary?: string }
  | { type: 'compaction_divider' }
  | { type: 'thinking'; id: string; content: string; signature?: string }
  | { type: 'redacted_thinking'; id: string; data: string }
  | SubTaskBlock

export interface AgentEvent {
  type: 'text' | 'tool_pending' | 'tool_call' | 'tool_progress' | 'tool_result'
    | 'web_search' | 'web_search_result' | 'web_fetch' | 'web_fetch_result'
    | 'error' | 'done' | 'saved' | 'context' | 'compacted' | 'slash_commands'
    | 'thinking_start' | 'thinking_delta' | 'thinking_complete' | 'redacted_thinking'
    | 'sub_task_start' | 'sub_task_progress' | 'sub_task_complete'
    | 'agent_tool_progress'
  content?: string
  id?: string
  tool_use_id?: string
  elapsed_time_seconds?: number
  name?: string
  input?: Record<string, unknown>
  result?: unknown
  message?: string
  messageId?: string
  current?: number
  total?: number
  query?: string
  url?: string
  title?: string
  results?: Array<{ url: string; title: string }>
  usage?: unknown
  messages?: Array<{ role: string; content: string }>
  signature?: string
  server_name?: string
  is_error?: boolean
  taskId?: string
  prompt?: string
  model?: string
  step?: number
  toolName?: string
  toolsUsed?: string[]
  toolCallCount?: number
  error?: string
  summary?: string
  duration?: number
  commands?: string[]
}

function openImageLightbox(src: string, alt?: string) {
  window.dispatchEvent(new CustomEvent('open-image-lightbox', { detail: { src, prompt: alt } }))
}

/**
 * Client-side block accumulator for SSE streams.
 */
export class ClientBlockAccumulator {
  blocks: ContentBlock[] = []
  private currentTextContent = ''

  process(event: AgentEvent): void {
    switch (event.type) {
      case 'text':
        this.currentTextContent += event.content || ''
        {
          const lastBlock = this.blocks[this.blocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.content = this.currentTextContent
          } else {
            this.blocks.push({ type: 'text', content: this.currentTextContent })
          }
        }
        break
      case 'tool_pending':
        this.currentTextContent = ''
        this.blocks.push({
          type: 'tool_use',
          id: event.id || `pending-${Date.now()}`,
          name: event.name || '',
          input: {},
        })
        break
      case 'tool_call': {
        this.currentTextContent = ''
        const idx = this.blocks.findIndex(b => b.type === 'tool_use' && b.id === event.id && !('result' in b))
        if (idx >= 0) {
          this.blocks[idx] = { ...this.blocks[idx], input: event.input || {} } as ContentBlock
        } else {
          this.blocks.push({
            type: 'tool_use',
            id: event.id || `fallback-${Date.now()}`,
            name: event.name || '',
            input: event.input || {},
          })
        }
        break
      }
      case 'tool_progress': {
        const progressText = event.total
          ? `${event.message} (${event.current}/${event.total})`
          : event.message || ''
        if (!progressText) break
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          if (this.blocks[i].type === 'tool_use' && !('result' in this.blocks[i])) {
            this.blocks[i] = { ...this.blocks[i], progress: progressText } as ContentBlock
            break
          }
        }
        break
      }
      case 'tool_result':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i]
          if (block.type === 'tool_use' && block.id === event.tool_use_id && !('result' in block)) {
            this.blocks[i] = { ...block, result: event.result, ...(event.duration ? { duration: event.duration } : {}) } as ContentBlock
            break
          }
        }
        break
      case 'web_search':
        this.currentTextContent = ''
        this.blocks.push({
          type: 'tool_use',
          id: `web_search-${Date.now()}`,
          name: 'web_search',
          input: { query: event.query || '' },
        })
        break
      case 'web_search_result':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i]
          if (block.type === 'tool_use' && block.name === 'web_search' && !('result' in block)) {
            this.blocks[i] = { ...block, result: { results: event.results }, ...(event.duration ? { duration: event.duration } : {}) } as ContentBlock
            break
          }
        }
        break
      case 'web_fetch':
        this.currentTextContent = ''
        this.blocks.push({
          type: 'tool_use',
          id: `web_fetch-${Date.now()}`,
          name: 'web_fetch',
          input: { url: event.url || '' },
        })
        break
      case 'web_fetch_result':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i]
          if (block.type === 'tool_use' && block.name === 'web_fetch' && !('result' in block)) {
            this.blocks[i] = { ...block, result: { url: event.url, title: event.title }, ...(event.duration ? { duration: event.duration } : {}) } as ContentBlock
            break
          }
        }
        break
      case 'error':
        this.currentTextContent += `\n\nError: ${event.message}`
        {
          const lastTextBlock = this.blocks[this.blocks.length - 1]
          if (lastTextBlock && lastTextBlock.type === 'text') {
            lastTextBlock.content = this.currentTextContent
          } else {
            this.blocks.push({ type: 'text', content: this.currentTextContent })
          }
        }
        break
      case 'thinking_start':
        this.currentTextContent = ''
        this.blocks.push({ type: 'thinking', id: event.id || `thinking-${Date.now()}`, content: '' })
        break
      case 'thinking_delta':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i]
          if (block.type === 'thinking' && block.id === event.id) {
            this.blocks[i] = { ...block, content: block.content + (event.content || '') } as ContentBlock
            break
          }
        }
        break
      case 'thinking_complete':
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i]
          if (block.type === 'thinking' && block.id === event.id) {
            this.blocks[i] = { ...block, signature: event.signature } as ContentBlock
            break
          }
        }
        break
      case 'sub_task_start': {
        this.currentTextContent = ''
        const existingGroup = this.blocks.find(b => b.type === 'sub_task_group') as SubTaskBlock | undefined
        const task: SubTaskInfo = {
          taskId: event.taskId || '', prompt: event.prompt || '', model: event.model || '',
          status: 'running', step: 0, currentTool: '', toolsUsed: [], toolCallCount: 0,
        }
        if (existingGroup) {
          const idx = this.blocks.indexOf(existingGroup)
          this.blocks[idx] = { type: 'sub_task_group', tasks: [...existingGroup.tasks, task] }
        } else {
          this.blocks.push({ type: 'sub_task_group', tasks: [task] })
        }
        break
      }
      case 'sub_task_progress': {
        const group = this.blocks.find(b => b.type === 'sub_task_group') as SubTaskBlock | undefined
        if (group) {
          const idx = this.blocks.indexOf(group)
          const tasks = group.tasks.map(t =>
            t.taskId === event.taskId
              ? { ...t, step: event.step || t.step, currentTool: event.toolName || t.currentTool }
              : t
          )
          this.blocks[idx] = { type: 'sub_task_group', tasks }
        }
        break
      }
      case 'agent_tool_progress': {
        const parentId = event.tool_use_id
        if (!parentId) break
        for (let i = this.blocks.length - 1; i >= 0; i--) {
          const block = this.blocks[i]
          if (block.type === 'tool_use' && block.id === parentId) {
            const existing = (block as any).nestedTools || []
            this.blocks[i] = {
              ...block,
              nestedTools: [...existing, { name: event.name || '', elapsed: event.elapsed_time_seconds }],
            } as ContentBlock
            break
          }
        }
        break
      }
      case 'sub_task_complete': {
        // Handle Agent tool completion via task_notification (tool_use_id targets the Agent block)
        if (event.tool_use_id && !event.taskId) {
          for (let i = this.blocks.length - 1; i >= 0; i--) {
            const block = this.blocks[i]
            if (block.type === 'tool_use' && block.id === event.tool_use_id) {
              this.blocks[i] = { ...block, subagentSummary: event.summary } as ContentBlock
              break
            }
          }
          break
        }
        // Handle parallel sub_task_group completion
        const grp = this.blocks.find(b => b.type === 'sub_task_group') as SubTaskBlock | undefined
        if (grp) {
          const idx = this.blocks.indexOf(grp)
          const tasks = grp.tasks.map(t =>
            t.taskId === event.taskId
              ? {
                  ...t,
                  status: (event.error ? 'error' : 'complete') as SubTaskInfo['status'],
                  summary: event.summary, toolsUsed: event.toolsUsed || t.toolsUsed,
                  toolCallCount: event.toolCallCount ?? t.toolCallCount, error: event.error,
                }
              : t
          )
          this.blocks[idx] = { type: 'sub_task_group', tasks }
        }
        break
      }
      case 'redacted_thinking':
        this.currentTextContent = ''
        this.blocks.push({
          type: 'redacted_thinking',
          id: event.id || `redacted-${Date.now()}`,
          data: (event as { data?: string }).data || '',
        })
        break
    }
  }

  snapshot(): ContentBlock[] {
    return [...this.blocks]
  }
}

// Markdown rendering

function getHostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function CitationBadge({ href, hostname, fullTitle, faviconUrl }: { href: string; hostname: string; fullTitle: string; faviconUrl: string }) {
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  const [tipStyle, setTipStyle] = useState<React.CSSProperties>({})
  const [visible, setVisible] = useState(false)

  const positionTip = useCallback(() => {
    const wrapper = wrapperRef.current
    const tip = tipRef.current
    if (!wrapper || !tip) return
    let container = wrapper.offsetParent as HTMLElement | null
    while (container && getComputedStyle(container).overflow === 'visible') {
      container = container.offsetParent as HTMLElement | null
    }
    if (!container) container = document.body
    const wrapperRect = wrapper.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const tipWidth = tip.scrollWidth
    let left = (wrapperRect.width - tipWidth) / 2
    const absLeft = wrapperRect.left + left
    const absRight = absLeft + tipWidth
    if (absLeft < containerRect.left + 4) left += (containerRect.left + 4) - absLeft
    else if (absRight > containerRect.right - 4) left -= absRight - (containerRect.right - 4)
    setTipStyle({ left: `${left}px` })
  }, [])

  return (
    <span ref={wrapperRef} className="relative inline-block mx-0.5 align-baseline"
      onMouseEnter={() => { positionTip(); setVisible(true) }}
      onMouseLeave={() => setVisible(false)}
    >
      <a href={href} target="_blank" rel="noopener noreferrer"
        className="no-underline inline-flex items-baseline px-1.5 py-px rounded bg-iris-surface-raised/60 hover:bg-iris-surface-raised/80 text-xs text-iris-text hover:text-iris-text transition-colors duration-150 border border-iris-border/40 leading-tight"
      >
        <span>{hostname}</span>
      </a>
      <span ref={tipRef}
        className={`pointer-events-none absolute bottom-full mb-1.5 flex items-center gap-2 px-3 py-2 rounded-lg bg-iris-surface border border-iris-border/60 shadow-float ring-1 ring-white/[0.06] z-50 whitespace-nowrap text-xs text-iris-text max-w-xs transition-opacity duration-100 ${visible ? 'opacity-100' : 'opacity-0'}`}
        style={tipStyle}
      >
        {faviconUrl && <img src={faviconUrl} alt="" className="w-4 h-4 rounded-sm shrink-0" />}
        <span className="truncate">{fullTitle || hostname}</span>
      </span>
    </span>
  )
}

const CITE_PREFIX = '\u200Bcite:'
const CITE_TOKEN_RE = /⟦cite:(.*?)\|(.*?)⟧/g

function preprocessCitations(content: string): string {
  return content.replace(CITE_TOKEN_RE, (_match, url, title) => {
    return ` [${CITE_PREFIX}${title}](${url})`
  })
}

function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative group/code">
      <button
        onClick={() => {
          navigator.clipboard.writeText(children)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        aria-label="Copy code"
        className="absolute right-2 top-2 px-1.5 py-0.5 text-xs text-iris-text-secondary bg-iris-surface-raised rounded border border-iris-border opacity-0 group-hover/code:opacity-100 hover:text-iris-text hover:border-iris-border transition-opacity"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <SyntaxHighlighter style={oneDarkNoBg} language={language} PreTag="div">
        {children}
      </SyntaxHighlighter>
    </div>
  )
}

export const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  const processed = preprocessCitations(content)

  return (
    <div className="markdown-body bg-transparent overflow-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const text = String(Array.isArray(children) ? children.join('') : children || '')
            if (text.startsWith(CITE_PREFIX)) {
              const fullTitle = text.slice(CITE_PREFIX.length)
              const hostname = href ? getHostname(href) : fullTitle
              const faviconUrl = href ? `https://www.google.com/s2/favicons?sz=32&domain=${hostname}` : ''
              return <CitationBadge href={href || ''} hostname={hostname} fullTitle={fullTitle} faviconUrl={faviconUrl} />
            }
            return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
          },
          img({ src, alt, ...props }) {
            return (
              <img src={src} alt={alt || ''}
                className="max-w-full max-h-[512px] rounded-lg cursor-pointer my-2"
                onClick={() => src && openImageLightbox(src, alt)}
                {...props}
              />
            )
          },
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const isInline = !match && !String(children).includes('\n')
            return !isInline ? (
              <CodeBlock language={match?.[1] || 'text'}>
                {String(children).replace(/\n$/, '')}
              </CodeBlock>
            ) : (
              <code className={className} {...props}>{children}</code>
            )
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
})
