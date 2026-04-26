import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { getCouncil, putCouncil, type AgentDef, type CouncilConfig } from '../api'
import {
  councilConfigToJsonString,
  configSignature,
  defaultSynthesizer,
  parseCouncilConfigText,
  uniqueNewAgentId,
} from '../agentsConfigUtils'

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
      <div className="mt-1.5 flex items-center justify-center gap-1 flex-wrap">
        <code className="text-[8px] text-slate-600 font-mono truncate max-w-full">
          {id}
        </code>
        {tools && (
          <span
            className="shrink-0 rounded bg-emerald-500/20 px-1 py-px text-[8px] font-medium text-emerald-300/90"
            title="Tools enabled in pipeline (web search, etc.)"
          >
            tools
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

/** Linear: 0..debateLen-1 = debaters, debateLen = synthesizer. */
function toLinearPos(sel: Selection | null, debateLen: number): number {
  if (debateLen < 1) return 0
  if (!sel || sel.kind === 'synth') return debateLen
  return Math.min(Math.max(0, sel.index), debateLen - 1)
}

function fromLinearPos(n: number, debateLen: number): Selection {
  if (debateLen < 1) return { kind: 'synth' }
  const t = debateLen + 1
  const k = ((n % t) + t) % t
  if (k < debateLen) return { kind: 'debate', index: k }
  return { kind: 'synth' }
}

function nextSelection(
  current: Selection | null,
  debateLen: number,
  dir: 1 | -1
): Selection {
  if (debateLen < 1) return { kind: 'synth' }
  const cur = toLinearPos(current, debateLen)
  return fromLinearPos(cur + dir, debateLen)
}

export function AgentsTab() {
  const [config, setConfig] = useState<CouncilConfig | null>(null)
  const [baselineSig, setBaselineSig] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const fileImportRef = useRef<HTMLInputElement>(null)
  const configRef = useRef<CouncilConfig | null>(null)
  useEffect(() => {
    configRef.current = config
  }, [config])

  const setConfigFromServer = useCallback((c: CouncilConfig) => {
    const next: CouncilConfig = {
      ...c,
      synthesizer: c.synthesizer ?? defaultSynthesizer(),
    }
    setConfig(next)
    setBaselineSig(configSignature(next))
    setSel((prev) => {
      if (prev?.kind === 'synth') return { kind: 'synth' }
      if (
        prev?.kind === 'debate' &&
        prev.index < next.debating_agents.length
      ) {
        return prev
      }
      return next.debating_agents.length
        ? { kind: 'debate', index: 0 }
        : { kind: 'synth' }
    })
    setEditorOpen(false)
  }, [])

  const loadFromApi = useCallback(
    async (fromUserReload = false) => {
      if (fromUserReload && config) {
        const d = configSignature(config)
        if (baselineSig != null && d !== baselineSig) {
          if (
            !window.confirm(
              'You have unsaved changes. Replace them with the file on the server?'
            )
          ) {
            return
          }
        }
      }
      setLoadError(null)
      try {
        const c = await getCouncil()
        setConfigFromServer(c)
        setSaveError(null)
        setSaved(false)
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : 'Failed to load council config'
        )
      }
    },
    [setConfigFromServer, config, baselineSig]
  )

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const c = await getCouncil()
        if (cancel) return
        setConfigFromServer(c)
      } catch (e) {
        if (!cancel) {
          setLoadError(
            e instanceof Error ? e.message : 'Failed to load council config'
          )
        }
      }
    })()
    return () => {
      cancel = true
    }
  }, [setConfigFromServer])

  const dirty = useMemo(() => {
    if (!config || baselineSig == null) return false
    return configSignature(config) !== baselineSig
  }, [config, baselineSig])

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

  const moveDebater = useCallback((index: number, dir: -1 | 1) => {
    setConfig((c) => {
      if (!c) return c
      const j = index + dir
      if (j < 0 || j >= c.debating_agents.length) return c
      const list = [...c.debating_agents]
      ;[list[index], list[j]] = [list[j]!, list[index]!]
      return { ...c, debating_agents: list }
    })
    setSel((s) => {
      if (s?.kind === 'debate' && s.index === index) {
        return { kind: 'debate', index: index + dir }
      }
      return s
    })
  }, [])

  const addDebater = useCallback(() => {
    setConfig((c) => {
      if (!c) return c
      const taken = new Set(c.debating_agents.map((a) => a.id))
      if (c.synthesizer) taken.add(c.synthesizer.id)
      const id = uniqueNewAgentId(taken)
      const fresh: AgentDef = {
        id,
        name: 'New debater',
        title: 'Perspective',
        system_prompt: '',
        tools_enabled: true,
      }
      const newIndex = c.debating_agents.length
      const next = { ...c, debating_agents: [...c.debating_agents, fresh] }
      queueMicrotask(() => {
        setSel({ kind: 'debate', index: newIndex })
        setEditorOpen(true)
      })
      return next
    })
  }, [])

  const removeDebater = useCallback(
    (index: number) => {
      if (!config || config.debating_agents.length <= 1) return
      if (!window.confirm('Remove this debater from the pipeline?')) return
      setConfig((c) => {
        if (!c || c.debating_agents.length <= 1) return c
        const list = c.debating_agents.filter((_, i) => i !== index)
        return { ...c, debating_agents: list }
      })
      setSel((s) => {
        if (s?.kind === 'debate') {
          if (s.index === index) {
            return { kind: 'debate', index: Math.max(0, index - 1) }
          }
          if (s.index > index) {
            return { kind: 'debate', index: s.index - 1 }
          }
        }
        return s
      })
    },
    [config]
  )

  const duplicateDebater = useCallback(
    (index: number) => {
      setConfig((c) => {
        if (!c) return c
        const source = c.debating_agents[index]
        if (!source) return c
        const taken = new Set(
          c.debating_agents.map((a) => a.id).concat(c.synthesizer ? [c.synthesizer.id] : [])
        )
        const newId = uniqueNewAgentId(taken, source.id)
        const copy: AgentDef = {
          ...source,
          id: newId,
          name: `${source.name} (copy)`,
        }
        const list = [
          ...c.debating_agents.slice(0, index + 1),
          copy,
          ...c.debating_agents.slice(index + 1),
        ]
        return { ...c, debating_agents: list }
      })
      setSel({ kind: 'debate', index: index + 1 })
    },
    []
  )

  const save = useCallback(async () => {
    if (!config?.synthesizer) return
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      await putCouncil(config)
      setBaselineSig(configSignature(config))
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [config])

  const exportJson = useCallback(() => {
    if (!config) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(
      new Blob([councilConfigToJsonString(config)], {
        type: 'application/json;charset=utf-8',
      })
    )
    a.download = 'council.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }, [config])

  const onImportFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0]
      e.target.value = ''
      if (!f) return
      void f.text().then((text) => {
        const parsed = parseCouncilConfigText(text)
        if (!parsed) {
          window.alert(
            'Invalid council JSON: need at least one debating agent with id, name, and fields matching the app.'
          )
          return
        }
        if (config && baselineSig != null && configSignature(config) !== baselineSig) {
          if (!window.confirm('You have unsaved edits. Replace council config with the imported file?')) {
            return
          }
        }
        if (!parsed.synthesizer) parsed.synthesizer = defaultSynthesizer()
        setConfig(parsed)
        setBaselineSig(configSignature(parsed))
        setSaveError(null)
        setSaved(false)
        setSel(
          parsed.debating_agents.length
            ? { kind: 'debate', index: 0 }
            : { kind: 'synth' }
        )
        setEditorOpen(false)
      })
    },
    [config, baselineSig]
  )

  const onNavAgent = useCallback((dir: 1 | -1) => {
    setSel((s) => {
      const c = configRef.current
      if (!c) return s
      return nextSelection(s, c.debating_agents.length, dir)
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && editorOpen) {
        e.preventDefault()
        e.stopPropagation()
        setEditorOpen(false)
        return
      }
      if (e.target && (e.target as HTMLElement).closest('textarea, input')) {
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
        } else {
          return
        }
      }
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault()
        onNavAgent(-1)
      }
      if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault()
        onNavAgent(1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onNavAgent, editorOpen])

  useEffect(() => {
    if (!editorOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [editorOpen])

  const selectedAgent = useMemo(() => {
    if (!config || !sel) return null
    if (sel.kind === 'synth') {
      return { role: 'synth' as const, agent: config.synthesizer! }
    }
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
  const canRemoveDebate = debaters.length > 1

  const saveToServerRow = (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving || !dirty}
        className="rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2.5 text-sm font-medium text-white"
      >
        {saving ? 'Saving…' : 'Save to server'}
      </button>
      {saveError && (
        <span className="text-xs text-amber-200/95">{saveError}</span>
      )}
      {saved && !saveError && !dirty && (
        <span className="text-xs text-emerald-300/90">Saved. Next run uses this council.</span>
      )}
      {dirty && !saving && (
        <span className="text-xs text-slate-500">
          Unsaved — save updates <code className="text-slate-400">council.json</code>
        </span>
      )}
    </div>
  )

  return (
    <div className="space-y-4 pb-8">
      <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
        Pick a node to edit. The <span className="text-slate-200">row</span> is debate order
        (each round); the <span className="text-violet-300/90">Synthesizer</span> condenses
        agreement before the plan writer. Config is written to{' '}
        <code className="text-slate-500">config/council.json</code> on save.
      </p>

      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3 rounded-xl border border-white/[0.08] bg-slate-900/30 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {dirty && (
            <span className="text-xs font-medium text-amber-200/95 rounded-full border border-amber-500/30 bg-amber-950/40 px-2.5 py-0.5">
              Unsaved changes
            </span>
          )}
          {!dirty && !saved && (
            <span className="text-xs text-slate-500">In sync with last save / load</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <button
            type="button"
            onClick={() => void loadFromApi(true)}
            className="text-xs font-medium rounded-lg border border-slate-600/60 bg-slate-900/50 px-2.5 py-1.5 text-slate-200 hover:bg-white/[0.05]"
            title="Reload from server (discards local edits with confirmation)"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={exportJson}
            className="text-xs font-medium rounded-lg border border-slate-600/60 bg-slate-900/50 px-2.5 py-1.5 text-slate-200 hover:bg-white/[0.05]"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => fileImportRef.current?.click()}
            className="text-xs font-medium rounded-lg border border-slate-600/60 bg-slate-900/50 px-2.5 py-1.5 text-slate-200 hover:bg-white/[0.05]"
          >
            Import…
          </button>
          <input
            ref={fileImportRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={onImportFile}
            aria-label="Import council JSON file"
          />
        </div>
      </div>

      <p className="text-[11px] text-slate-500">
        Tip: <kbd className="kbd-hint">Alt</kbd> + <kbd className="kbd-hint">↑</kbd> /{' '}
        <kbd className="kbd-hint">↓</kbd> to change selection; click a node to open the editor.{' '}
        <kbd className="kbd-hint">Esc</kbd> closes the editor.
      </p>

        {/* Graph — full width so the page does not feel cramped */}
        <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900/50 to-slate-950/60 p-4 sm:p-5 overflow-x-auto max-w-5xl">
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">
              Pipeline
            </div>
            <div className="flex items-center gap-2">
              {selectedAgent && !editorOpen && (
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  className="text-xs font-medium rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-violet-200 hover:bg-violet-500/20"
                >
                  Open editor
                </button>
              )}
            <button
              type="button"
              onClick={addDebater}
              className="text-xs font-medium text-violet-300 hover:text-violet-200"
            >
              + Add debater
            </button>
            </div>
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
                      setEditorOpen(true)
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
                  setEditorOpen(true)
                }}
              />
            </div>
          </div>

          <ul className="mt-4 space-y-1.5 text-[10px] text-slate-500 border-t border-white/5 pt-3">
            <li>
              <span className="text-emerald-400/80">tools</span> = search/tools enabled in the pipeline
            </li>
            <li>Ids are stable in transcripts; duplicate creates a new id.</li>
          </ul>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/20 p-4 sm:p-5 max-w-5xl">
          {saveToServerRow}
        </div>

        {editorOpen &&
          selectedAgent &&
          createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center p-0 sm:p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="council-editor-title"
            >
              <button
                type="button"
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                aria-label="Close editor"
                onClick={() => setEditorOpen(false)}
              />
              <div
                className="relative z-10 flex w-full max-w-2xl min-h-0 flex-col overflow-hidden rounded-t-2xl border border-white/10 bg-[#0c0e16] shadow-2xl sm:mt-0 sm:max-h-[min(90dvh,56rem)] sm:rounded-2xl max-h-[92dvh]"
                onClick={(e) => e.stopPropagation()}
              >
                {selectedAgent.role === 'synth' ? (
                  <>
                    <div className="shrink-0 flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
                      <div>
                        <h2
                          id="council-editor-title"
                          className="text-base font-semibold text-violet-200"
                        >
                          Synthesizer
                        </h2>
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {selectedAgent.agent.id}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onNavAgent(-1)}
                          className="text-xs rounded-lg border border-slate-600/50 px-2.5 py-1.5 text-slate-300 hover:bg-white/[0.05]"
                          title="Previous debater (Alt+↑)"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => onNavAgent(1)}
                          className="text-xs rounded-lg border border-slate-600/50 px-2.5 py-1.5 text-slate-300 hover:bg-white/[0.05]"
                          title="First debater (Alt+↓)"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditorOpen(false)}
                          className="ml-1 rounded-lg border border-slate-600/50 p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200"
                          aria-label="Close"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            aria-hidden
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
                      <AgentFields
                        agent={selectedAgent.agent}
                        onChange={updateSynth}
                        promptMinH="min-h-[12rem] sm:min-h-[16rem]"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="shrink-0 flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3 sm:px-5 flex-wrap">
                      <div>
                        <h2
                          id="council-editor-title"
                          className="text-base font-semibold text-slate-100"
                        >
                          {selectedAgent.agent.name || 'Agent'}
                        </h2>
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {selectedAgent.agent.id} · order {selectedAgent.index + 1} of {debaters.length}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1 max-w-full">
                        <button
                          type="button"
                          onClick={() => onNavAgent(-1)}
                          className="text-xs rounded-lg border border-slate-600/50 px-2 py-1 text-slate-300 hover:bg-white/[0.05]"
                          title="Previous node (Alt+↑)"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => onNavAgent(1)}
                          className="text-xs rounded-lg border border-slate-600/50 px-2 py-1 text-slate-300 hover:bg-white/[0.05]"
                          title="Next node (Alt+↓)"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => moveDebater(selectedAgent.index, -1)}
                          disabled={selectedAgent.index === 0}
                          className="text-xs rounded-lg border border-slate-600/50 px-2 py-1 text-slate-300 hover:bg-white/[0.05] disabled:opacity-30"
                        >
                          ←
                        </button>
                        <button
                          type="button"
                          onClick={() => moveDebater(selectedAgent.index, 1)}
                          disabled={selectedAgent.index >= debaters.length - 1}
                          className="text-xs rounded-lg border border-slate-600/50 px-2 py-1 text-slate-300 hover:bg-white/[0.05] disabled:opacity-30"
                        >
                          →
                        </button>
                        <button
                          type="button"
                          onClick={() => duplicateDebater(selectedAgent.index)}
                          className="text-xs rounded-lg border border-slate-600/50 px-2 py-1 text-slate-300 hover:bg-white/[0.05]"
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          onClick={() => removeDebater(selectedAgent.index)}
                          disabled={!canRemoveDebate}
                          className="text-xs rounded-lg border border-rose-500/30 px-2 py-1 text-rose-200/90 hover:bg-rose-500/10 disabled:opacity-30"
                        >
                          Remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditorOpen(false)}
                          className="ml-auto rounded-lg border border-slate-600/50 p-1.5 text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 sm:ml-0"
                          aria-label="Close"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            aria-hidden
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
                      <AgentFields
                        agent={selectedAgent.agent}
                        onChange={(p) => updateDebater(selectedAgent.index, p)}
                        promptMinH="min-h-[12rem] sm:min-h-[16rem]"
                      />
                    </div>
                  </>
                )}

                <div className="shrink-0 space-y-3 border-t border-white/10 bg-[#090a0e] px-4 py-3 sm:px-5 sm:rounded-b-2xl">
                  {saveToServerRow}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEditorOpen(false)}
                      className="text-sm font-medium text-slate-400 hover:text-slate-200"
                    >
                      Done
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )}
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
  const sp = agent.system_prompt ?? ''
  const lines = sp ? sp.split(/\r\n|\r|\n/).length : 0
  const chars = sp.length

  const copyPrompt = useCallback(() => {
    if (!sp) return
    void navigator.clipboard.writeText(sp)
  }, [sp])

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
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="text-xs text-slate-500">System prompt</label>
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span>
              {lines} line{lines === 1 ? '' : 's'} · {chars} chars
            </span>
            <button
              type="button"
              onClick={copyPrompt}
              disabled={!sp}
              className="text-violet-400 hover:text-violet-300 disabled:opacity-30 text-xs font-medium"
            >
              Copy
            </button>
          </div>
        </div>
        <textarea
          className={`mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-violet-500/50 ${promptMinH}`}
          value={agent.system_prompt}
          onChange={(e) => onChange({ system_prompt: e.target.value })}
        />
      </div>
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
