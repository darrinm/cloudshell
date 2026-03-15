import { useState, useEffect } from 'react'

export interface ContextUsage {
  contextWindow: number
  inputTokens: number
  outputTokens: number
  systemTokens: number
  memoryTokens?: number
  toolCategories: Record<string, number>
  promptTokens: number
  agentTokens: number
  cacheRead?: number
  cacheCreation?: number
}

const BAND_COLORS: Record<string, string> = {
  System: '#6366f1',
  Tools: '#64748b',
  MCP: '#a78bfa',
  Other: '#a1a1aa',
  Prompts: '#e2e8f0',
  Agent: '#94a3b8',
  Output: '#fbbf24',
}

const CATEGORY_ORDER = ['Tools', 'MCP', 'Other']

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

interface Band {
  label: string
  tokens: number
  color: string
  percent: number
}

function buildBands(usage: ContextUsage): Band[] {
  const total = usage.contextWindow
  const bands: Band[] = []
  bands.push({ label: 'System', tokens: usage.systemTokens, color: BAND_COLORS.System, percent: (usage.systemTokens / total) * 100 })
  for (const cat of CATEGORY_ORDER) {
    const tokens = usage.toolCategories[cat]
    if (tokens && tokens > 0) {
      bands.push({ label: cat, tokens, color: BAND_COLORS[cat] || '#a1a1aa', percent: (tokens / total) * 100 })
    }
  }
  if (usage.promptTokens != null && usage.agentTokens != null) {
    bands.push({ label: 'Prompts', tokens: usage.promptTokens, color: BAND_COLORS.Prompts, percent: (usage.promptTokens / total) * 100 })
    bands.push({ label: 'Agent', tokens: usage.agentTokens, color: BAND_COLORS.Agent, percent: (usage.agentTokens / total) * 100 })
  }
  bands.push({ label: 'Output', tokens: usage.outputTokens, color: BAND_COLORS.Output, percent: (usage.outputTokens / total) * 100 })
  return bands
}

export default function ContextMeter({ usage }: { usage: ContextUsage }) {
  const [hover, setHover] = useState<{ label: string; tokens: number; percent: number; x: number; y: number } | null>(null)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    if (!showModal) return
    function handleKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') setShowModal(false) }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [showModal])

  const bands = buildBands(usage)
  const visibleBands = [...bands].filter(b => b.percent >= 0.3).sort((a, b) => b.tokens - a.tokens)
  const maxTokens = Math.max(...bands.map(b => b.tokens))

  return (
    <>
      <div
        className="h-2 rounded-full bg-iris-surface overflow-hidden relative cursor-pointer"
        onClick={() => setShowModal(true)}
        onMouseLeave={() => setHover(null)}
      >
        {(() => {
          let offset = 0
          return visibleBands.map((band) => {
            const left = offset
            offset += band.percent
            return (
              <div
                key={band.label}
                className="absolute top-0 h-full transition-all duration-300"
                style={{ left: `${left}%`, width: `${band.percent}%`, backgroundColor: band.color }}
                onMouseEnter={(e) => {
                  const rect = (e.target as HTMLElement).getBoundingClientRect()
                  setHover({ label: band.label, tokens: band.tokens, percent: band.percent, x: rect.left + rect.width / 2, y: rect.top })
                }}
              />
            )
          })
        })()}
      </div>

      {hover && !showModal && (
        <div
          className="fixed z-50 px-2 py-1 bg-iris-bg-subtle border border-iris-border rounded text-xs text-iris-text pointer-events-none shadow-float ring-1 ring-white/[0.06]"
          style={{ left: hover.x, top: hover.y - 32, transform: 'translateX(-50%)' }}
        >
          <span className="font-medium text-iris-text">{hover.label}</span>{' '}
          {formatTokens(hover.tokens)} ({hover.percent.toFixed(1)}%)
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowModal(false)}>
          <div className="bg-iris-surface-hover border border-iris-border rounded-lg shadow-float max-w-md mx-4 animate-[fadeInScale_150ms_ease-out]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-iris-border">
              <h2 className="text-sm font-semibold text-iris-text">Context Breakdown</h2>
              <button onClick={() => setShowModal(false)} aria-label="Close" className="p-1 rounded-md text-iris-text-secondary hover:text-iris-text hover:bg-white/[0.04]">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-4 py-3 space-y-2">
              {[...bands].filter(b => b.tokens > 0).sort((a, b) => b.tokens - a.tokens).map((band) => (
                <div key={band.label} className="flex items-center gap-3">
                  <span className="text-xs text-iris-text-secondary w-20 shrink-0 truncate">{band.label}</span>
                  <div className="flex-1 h-3 bg-iris-surface rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-300" style={{ width: `${(band.tokens / maxTokens) * 100}%`, backgroundColor: band.color }} />
                  </div>
                  <span className="text-xs text-iris-text tabular-nums w-14 text-right shrink-0">{formatTokens(band.tokens)}</span>
                </div>
              ))}
            </div>
            {(usage.cacheRead != null && usage.cacheRead > 0) && (
              <div className="px-4 py-3 border-t border-iris-border text-xs text-iris-text-muted">
                Cache read: {formatTokens(usage.cacheRead)}
                {usage.cacheCreation != null && usage.cacheCreation > 0 && <> &middot; Cache write: {formatTokens(usage.cacheCreation)}</>}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
