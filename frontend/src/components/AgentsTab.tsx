import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getCouncil,
  putCouncil,
  type AgentDef,
  type CouncilConfig,
} from '../api'

function defaultSynthesizer(): AgentDef {
  return {
    id: 'synthesizer',
    name: 'Synthesizer',
    title: 'Alignment',
    system_prompt: '',
    tools_enabled: false,
  }
}

type Selection = { kind: 'debate'; index: number } | { kind: 'synth' }

function initials(name: string, id: string) {
  const s = (name || id).trim()
  if (!s) return '?'
  return s.slice(0, 2).toUpperCase()
}

type GraphNodeProps = {
  label: string
  subtitle: string
  id: string
  tools: boolean
  variant: 'debate' | 'synth'
  selected: boolean
  step?: number
  onSelect: () => void
}

function GraphNode({
  label,
  subtitle,
  id,
  tools,
  variant,
  selected,
  step,
  onSelect,
}: GraphNodeProps) {
  const isSynth = variant === 'synth'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`
        group relative flex flex-col items-center text-center rounded-2xl border min-w-[5.5rem] max-w-[7.5rem] sm:min-w-[6.5rem] sm:max-w-[8rem] px-2 py-2.5 transition-all
        ${
          selected
            ? isSynth
              ? 'border-violet-400/70 bg-violet-500/20 ring-2 ring-violet-500/50 shadow-lg shadow-violet-900/30 scale-[1.02]'
              : 'border-slate-400/50 bg-slate-800/80 ring-2 ring-violet-500/50 shadow-lg shadow-black/20 scale-[1.02]'
            : isSynth
              ? 'border-violet-500/25 bg-violet-950/40 hover:border-violet-500/40 hover:bg-violet-900/20'
              : 'border-slate-600/50 bg-slate-900/50 hover:border-slate-500/60 hover:bg-slate-800/60'
        }
      `}
    >
      {step != null && (
        <span className="absolute -top-2 -left-1 flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 border border-slate-600 text-[10px] font-mono text-slate-400">
          {step}
        </span>
      )}
      <span
        className={`
          flex h-10 w-10 items-center justify-center rounded-xl text-xs font-bold mb-1.5
          ${
            isSynth
              ? 'bg-violet-600/50 text-violet-100'
              : 'bg-slate-700/80 text-slate-200'
          }
        `}
      >
        {initials(label, id)}
      </span>
      <span className="text-[11px] font-semibold text-slate-100 line-clamp-2 leading-tight">
        {label || id}
      </span>
      {subtitle && (
        <span className="text-[9px] text-slate-500 line-clamp-2 mt-0.5 leading-snug">
          {subtitle}
        </span>
      )}
      <div className="mt-1.5 flex items-center justify-center gap-1">
        <code className="text-[8px] text-slate-600 font-mono truncate max-w-full">{id}</code>
        {tools && (
          <span
            className="shrink-0 rounded bg-emerald-500/20 px-1 text-[8px] text-emerald-300/90"
            title="Tools enabled"
          >
            T
          </span>
        )}
      </div>
    </button>
  )
}

function EdgeH() {
  return (
    <div
      className="hidden sm:flex items-center self-center px-0.5"
      aria-hidden
    >
      <div className="h-px w-4 sm:w-6 bg-gradient-to-r from-slate-600/50 via-slate-500/80 to-slate-600/50" />
      <span className="text-slate-600 text-[10px] px-0.5">→</span>
      <div className="h-px w-4 sm:w-6 bg-gradient-to-r from-slate-600/50 via-slate-500/80 to-slate-600/50" />
    </div>
  )
}

function EdgeV() {
  return (
    <div className="flex flex-col items-center py-0.5" aria-hidden>
      <div className="h-3 w-px bg-gradient-to-b from-slate-500/60 to-violet-500/40" />
      <span className="text-[9px] text-slate-500 leading-none py-0.5">↓</span>
      <div className="h-3 w-px bg-gradient-to-b from-violet-500/30 to-slate-500/40" />
    </div>
  )
}

export function AgentsTab() {
  const [config, setConfig] = useState<CouncilConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const c = await getCouncil()
        if (cancel) return
        if (!c.synthesizer) {
          c.synthesizer = defaultSynthesizer()
        }
        setConfig(c)
        if (!cancel) {
          setSel((prev) => {
            if (
              prev?.kind === 'debate' &&
              prev.index < c.debating_agents.length
            ) {
              return prev
            }
            return { kind: 'debate', index: 0 }
          })
        }
      } catch (e) {
        if (!cancel) {
          setLoadError(e instanceof Error ? e.message : 'Failed to load council config')
        }
      }
    })()
    return () => {
      cancel = true
    }
  }, [])

  const updateDebater = useCallback((index: number, patch: Partial<AgentDef>) => {
    setConfig((c) => {
      if (!c) return c
      const next = [...c.debating_agents]
      next[index] = { ...next[index]!, ...patch }
      return { ...c, debating_agents: next }
    })
  }, [])

  const updateSynth = useCallback((patch: Partial<AgentDef>) => {
    setConfig((c) => {
      if (!c) return c
      const base = c.synthesizer ?? defaultSynthesizer()
      return { ...c, synthesizer: { ...base, ...patch } }
    })
  }, [])

  const save = useCallback(async () => {
    if (!config?.synthesizer) return
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      await putCouncil(config)
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [config])

  const selectedAgent = useMemo(() => {
    if (!config || !sel) return null
    if (sel.kind === 'synth') return { role: 'synth' as const, agent: config.synthesizer! }
    const ag = config.debating_agents[sel.index]
    if (!ag) return null
    return { role: 'debate' as const, index: sel.index, agent: ag }
  }, [config, sel])

  if (loadError) {
    return (
      <p className="text-sm text-rose-300/90 border border-rose-500/30 rounded-xl p-3">
        {loadError}
      </p>
    )
  }

  if (!config) {
    return (
      <p className="text-sm text-slate-500">Loading council configuration…</p>
    )
  }

  const debaters = config.debating_agents
  const synth = config.synthesizer!

  return (
    <div className="space-y-4 pb-8">
      <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
        Pick a node to edit. The <span className="text-slate-200">row</span> is debate order
        (each round); the <span className="text-violet-300/90">Synthesizer</span> condenses
        agreement before the plan writer. Saved to <code className="text-slate-500">config/council.json</code>.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,400px)_minmax(0,1fr)] gap-5 lg:gap-8 items-start">
        {/* Graph panel */}
        <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900/50 to-slate-950/60 p-4 sm:p-5 overflow-x-auto">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-3">
            Pipeline
          </div>

          <div className="flex flex-col items-stretch min-w-[min(100%,18rem)]">
            <p className="text-[9px] text-slate-500 mb-2">1 · Debating agents (in order each round)</p>
            <div className="flex flex-wrap justify-center sm:flex-nowrap sm:justify-center items-center gap-y-2 gap-x-0">
              {debaters.map((ag, i) => (
                <div key={ag.id} className="flex items-center">
                  {i > 0 && <EdgeH />}
                  <GraphNode
                    label={ag.name}
                    subtitle={ag.title}
                    id={ag.id}
                    tools={ag.tools_enabled}
                    variant="debate"
                    step={i + 1}
                    selected={sel?.kind === 'debate' && sel.index === i}
                    onSelect={() => {
                      setSel({ kind: 'debate', index: i })
                      setSaved(false)
                    }}
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-center my-1">
              <EdgeV />
            </div>
            <p className="text-center text-[9px] text-slate-500 -mt-0.5 mb-1">merge & align</p>

            <div className="flex justify-center">
              <GraphNode
                label={synth.name}
                subtitle={synth.title}
                id={synth.id}
                tools={synth.tools_enabled}
                variant="synth"
                selected={sel?.kind === 'synth'}
                onSelect={() => {
                  setSel({ kind: 'synth' })
                  setSaved(false)
                }}
              />
            </div>
          </div>

          <ul className="mt-4 space-y-1.5 text-[10px] text-slate-500 border-t border-white/5 pt-3">
            <li>
              <span className="text-slate-400">T</span> = tools enabled in pipeline
            </li>
            <li>Ids are stable — used in saved transcripts.</li>
          </ul>
        </div>

        {/* Editor panel */}
        <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5 min-h-[12rem]">
          {!selectedAgent ? (
            <p className="text-sm text-slate-500">Select a node in the graph.</p>
          ) : selectedAgent.role === 'synth' ? (
            <>
              <div className="flex items-start justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-violet-200">Edit: Synthesizer</h3>
                  <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                    {selectedAgent.agent.id}
                  </p>
                </div>
              </div>
              <AgentFields
                agent={selectedAgent.agent}
                onChange={updateSynth}
                promptMinH="min-h-[10rem]"
              />
            </>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2 mb-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Edit: {selectedAgent.agent.name || 'Agent'}
                  </h3>
                  <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                    {selectedAgent.agent.id}
                  </p>
                </div>
                <span className="text-[9px] text-slate-500 shrink-0">
                  Order {selectedAgent.index + 1} in debate
                </span>
              </div>
              <AgentFields
                agent={selectedAgent.agent}
                onChange={(p) => updateDebater(selectedAgent.index, p)}
                promptMinH="min-h-[10rem]"
              />
            </>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2 pt-2 border-t border-white/5">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
            >
              {saving ? 'Saving…' : 'Save all agents'}
            </button>
            {saveError && (
              <span className="text-xs text-amber-200/95">{saveError}</span>
            )}
            {saved && !saveError && (
              <span className="text-xs text-emerald-300/90">Saved. Next run uses this council.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentFields({
  agent,
  onChange,
  promptMinH,
}: {
  agent: AgentDef
  onChange: (p: Partial<AgentDef>) => void
  promptMinH: string
}) {
  return (
    <div className="space-y-3">
      <label className="block text-xs text-slate-500">
        Display name
        <input
          type="text"
          className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          value={agent.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </label>
      <label className="block text-xs text-slate-500">
        Subtitle / focus
        <input
          type="text"
          className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          value={agent.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </label>
      <label className="block text-xs text-slate-500">
        System prompt
        <textarea
          className={`mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-violet-500/50 ${promptMinH}`}
          value={agent.system_prompt}
          onChange={(e) => onChange({ system_prompt: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input
          type="checkbox"
          className="rounded border-slate-600 bg-slate-900 accent-violet-500"
          checked={agent.tools_enabled}
          onChange={(e) => onChange({ tools_enabled: e.target.checked })}
        />
        Tools enabled (search / tools when supported)
      </label>
    </div>
  )
}
