import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import {
  createCouncil,
  deleteCouncil,
  deleteCouncilVersion,
  getBuiltinPrompts,
  getCouncil,
  getTools,
  listCouncilVersions,
  listCouncils,
  putBuiltinPrompt,
  putCouncil,
  regenerateCouncilPrompts,
  resetBuiltinPrompts,
  restoreCouncilVersion,
  type AgentDef,
  type AgentToolDefinition,
  type BuiltinPromptItem,
  type CouncilConfig,
  type CouncilVersionRow,
  type OutputMode,
} from '../api'
import {
  councilConfigToJsonString,
  configSignature,
  mergeCouncilDefaults,
  parseCouncilConfigText,
  slugAgentId,
  agentHasEffectiveTools,
} from '../agentsConfigUtils'
import { PromptPipelineMap } from './PromptPipelineMap'
import { PromptRefineWidget } from './PromptRefineWidget'

/** Sidebar / category order for Pipeline defaults (unknown categories sort last). */
const PIPELINE_CATEGORY_ORDER: string[] = [
  'Orchestrator',
  'Council bootstrap',
  'Specialists',
  'Research',
  'Plan writer',
  'Artifact — report',
  'Artifact — code',
  'Plan refine',
  'Prompt polish (settings)',
]

function sortPipelineCategories(a: string, b: string): number {
  const ia = PIPELINE_CATEGORY_ORDER.indexOf(a)
  const ib = PIPELINE_CATEGORY_ORDER.indexOf(b)
  const sa = ia === -1 ? 999 : ia
  const sb = ib === -1 ? 999 : ib
  if (sa !== sb) return sa - sb
  return a.localeCompare(b)
}

/** Staged UX while POST /councils runs (LLM autofill has no granular server events). */
const CREATE_MODAL_PROGRESS_AUTOFILL: string[] = [
  'Contacting server…',
  'Copying template and saving metadata…',
  'Model is drafting orchestrator, specialists, and routing guidelines — this is usually the slow step…',
  'Still running — local models often need 30 seconds to a few minutes…',
  'Almost done — finalizing on the server…',
]

const REGENERATE_COUNCIL_PROGRESS: string[] = [
  'Snapshotting current council…',
  'Calling model to refresh prompts from profile and roster…',
  'Still running — same kind of work as new-council autofill…',
  'Applying merged prompts and saving…',
]

type Selection = { kind: 'debate'; index: number }

function AgentToolPicker({
  agent,
  registeredTools,
  onChange,
}: {
  agent: AgentDef
  registeredTools: AgentToolDefinition[]
  onChange: (p: Partial<AgentDef>) => void
}) {
  const regIds = useMemo(
    () => registeredTools.map((t) => t.id),
    [registeredTools],
  )

  const toggleTool = useCallback(
    (tid: string, checked: boolean) => {
      if (!agent.tools_enabled || regIds.length === 0) return
      const curEff = new Set<string>()
      const raw = agent.tool_ids ?? []
      if (raw.length === 0) regIds.forEach((id) => curEff.add(id))
      else {
        for (const id of raw) {
          if (regIds.includes(id)) curEff.add(id)
        }
      }
      if (checked) curEff.add(tid)
      else curEff.delete(tid)
      if (curEff.size === 0) {
        onChange({ tools_enabled: false, tool_ids: [] })
        return
      }
      if (curEff.size === regIds.length) {
        onChange({ tool_ids: [] })
        return
      }
      onChange({ tool_ids: [...curEff].sort() })
    },
    [agent.tools_enabled, agent.tool_ids, onChange, regIds],
  )

  if (registeredTools.length === 0) return null

  return (
    <div className="rounded-lg border border-white/[0.06] bg-slate-900/40 px-2.5 py-2 space-y-2">
      <div className="text-[11px] text-slate-400 leading-snug">
        <span className="font-medium text-slate-300">Tool access</span>
        <p className="text-[10px] text-slate-500 mt-1">
          Empty list in saved JSON means <span className="text-slate-400">all</span> registry tools for this role.
          Uncheck a tool to store an explicit subset (new server tools only appear automatically when the list is
          empty).
        </p>
      </div>
      <div className="space-y-1.5">
        {registeredTools.map((t) => (
          <label
            key={t.id}
            className={`flex items-start gap-2 text-[11px] ${
              agent.tools_enabled ? 'text-slate-300 cursor-pointer' : 'text-slate-600 cursor-not-allowed'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 rounded border-slate-600 bg-slate-950 text-violet-500 focus:ring-violet-500/40 shrink-0"
              disabled={!agent.tools_enabled}
              checked={
                !agent.tools_enabled
                  ? false
                  : !agent.tool_ids?.length
                    ? true
                    : (agent.tool_ids ?? []).includes(t.id)
              }
              onChange={(e) => toggleTool(t.id, e.target.checked)}
            />
            <span>
              <span className="font-medium">{t.name}</span>
              <code className="ml-1 text-[10px] text-slate-500">{t.id}</code>
              <span className="block text-[10px] text-slate-500 leading-snug mt-0.5">
                {t.description}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}

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
  selected: boolean
  step?: number
  onSelect: () => void
}

function GraphNode({
  label,
  subtitle,
  id,
  tools,
  selected,
  step,
  onSelect,
}: GraphNodeProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`
        group relative flex flex-col items-center text-center rounded-2xl border min-w-[5.5rem] max-w-[7.5rem] sm:min-w-[6.5rem] sm:max-w-[8rem] px-2 py-2.5 transition-all
        ${
          selected
            ? 'border-slate-400/50 bg-slate-800/80 ring-2 ring-violet-500/50 shadow-lg shadow-black/20 scale-[1.02]'
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
          bg-slate-700/80 text-slate-200
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
            title="Per-agent tool capabilities (see editor). Orchestrator run_research is separate."
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

function toLinearPos(sel: Selection | null, debateLen: number): number {
  if (debateLen < 1) return 0
  if (sel?.kind === 'debate') {
    return Math.min(Math.max(0, sel.index), Math.max(0, debateLen - 1))
  }
  return 0
}

function fromLinearPos(n: number, debateLen: number): Selection | null {
  if (debateLen < 1) return null
  const k = ((n % debateLen) + debateLen) % debateLen
  return { kind: 'debate', index: k }
}

function nextSelection(
  current: Selection | null,
  debateLen: number,
  dir: 1 | -1,
): Selection | null {
  if (debateLen < 1) return null
  const cur = toLinearPos(current, debateLen)
  return fromLinearPos(cur + dir, debateLen)
}

const NEW_COUNCIL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

const OUTPUT_MODES: { value: OutputMode; label: string; hint: string }[] = [
  {
    value: 'plan',
    label: 'Implementation plan',
    hint: 'Structured JSON → markdown (phases, checklist).',
  },
  {
    value: 'report',
    label: 'Report',
    hint: 'Prose markdown document from council context.',
  },
  { value: 'code', label: 'Code file', hint: 'Single source file body for download.' },
  {
    value: 'conversation',
    label: 'Conversation only',
    hint: 'No file; finish with orchestrator_done when done.',
  },
  {
    value: 'none',
    label: 'Nil (no output)',
    hint: 'No primary file; run ends after discussion without an artifact step.',
  },
]

function CouncilOutputSettings({
  config,
  setConfig,
}: {
  config: CouncilConfig
  setConfig: Dispatch<SetStateAction<CouncilConfig | null>>
}) {
  const merged = mergeCouncilDefaults(config)

  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/20 to-slate-950/50 p-4 sm:p-5 max-w-5xl space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-emerald-200/95">Primary output</h3>
        <p className="text-[11px] text-slate-500 mt-1 max-w-2xl leading-relaxed">
          Define what the run produces after orchestration. URLs you want in the research brief are set in
          the main chat under Outputs → Research, not here.
        </p>
      </div>
      <label className="block text-xs text-slate-400 max-w-xl">
        Primary output
        <select
          className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          value={merged.output_mode ?? 'plan'}
          onChange={(e) =>
            setConfig((c) =>
              c ? { ...c, output_mode: e.target.value as OutputMode } : c
            )
          }
        >
          {OUTPUT_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label} — {m.hint}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-slate-400 max-w-2xl">
        Output instructions (report / code)
        <textarea
          className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500/40 min-h-[4rem] font-mono text-[13px]"
          placeholder="Audience, sections, programming language, style…"
          value={merged.output_instructions ?? ''}
          onChange={(e) =>
            setConfig((c) =>
              c ? { ...c, output_instructions: e.target.value } : c
            )
          }
        />
      </label>
      <label className="block text-xs text-slate-400 max-w-md">
        Artifact filename (optional)
        <input
          type="text"
          className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
          placeholder="e.g. report.md, main.py"
          value={merged.artifact_filename ?? ''}
          onChange={(e) =>
            setConfig((c) =>
              c ? { ...c, artifact_filename: e.target.value } : c
            )
          }
        />
      </label>
    </div>
  )
}

function PipelineBuiltinPrompts({
  refineModels,
  refineDefaultModel,
}: {
  refineModels: string[]
  refineDefaultModel: string
}) {
  const [items, setItems] = useState<BuiltinPromptItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [showTouchesOnly, setShowTouchesOnly] = useState(false)
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => new Set())
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(() => new Set())

  const reload = useCallback(async () => {
    const rows = await getBuiltinPrompts()
    setItems(rows)
    setDrafts((prev) => {
      const next = { ...prev }
      for (const r of rows) next[r.key] = r.content
      return next
    })
  }, [])

  useEffect(() => {
    let cancel = false
    setLoading(true)
    void (async () => {
      try {
        await reload()
        if (!cancel) setErr(null)
      } catch (e) {
        if (!cancel) {
          setErr(e instanceof Error ? e.message : 'Could not load pipeline prompts')
        }
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => {
      cancel = true
    }
  }, [reload])

  const filteredItems = useMemo(() => {
    let list = items
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (it) =>
          it.key.toLowerCase().includes(q) ||
          it.title.toLowerCase().includes(q) ||
          it.category.toLowerCase().includes(q) ||
          it.description.toLowerCase().includes(q)
      )
    }
    if (showTouchesOnly) {
      list = list.filter((it) => {
        const dirty = (drafts[it.key] ?? '') !== it.content
        return dirty || !it.is_default
      })
    }
    return list
  }, [items, searchQuery, showTouchesOnly, drafts])

  const groupedFiltered = useMemo(() => {
    const m = new Map<string, BuiltinPromptItem[]>()
    for (const it of filteredItems) {
      const arr = m.get(it.category) ?? []
      arr.push(it)
      m.set(it.category, arr)
    }
    return [...m.entries()].sort(([a], [b]) => sortPipelineCategories(a, b))
  }, [filteredItems])

  const stats = useMemo(() => {
    const customized = items.filter((i) => !i.is_default).length
    const dirty = items.filter((i) => (drafts[i.key] ?? '') !== i.content).length
    return { customized, dirty, total: items.length }
  }, [items, drafts])

  const toggleCat = useCallback((cat: string) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }, [])

  const togglePromptOpen = useCallback((key: string) => {
    setExpandedPrompts((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const expandAllPromptEditors = useCallback(() => {
    setExpandedPrompts(new Set(filteredItems.map((i) => i.key)))
  }, [filteredItems])

  const collapseAllPromptEditors = useCallback(() => {
    setExpandedPrompts(new Set())
  }, [])

  const expandAllCategories = useCallback(() => {
    setCollapsedCats(new Set())
  }, [])

  const saveKey = async (key: string) => {
    setSavingKey(key)
    setErr(null)
    try {
      await putBuiltinPrompt(key, drafts[key] ?? '')
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingKey(null)
    }
  }

  const onResetAll = async () => {
    if (
      !window.confirm(
        'Reset every pipeline prompt override to built-in defaults? This clears data/prompt_overrides.json.'
      )
    ) {
      return
    }
    setErr(null)
    try {
      const j = await resetBuiltinPrompts()
      setItems(j.prompts)
      const d: Record<string, string> = {}
      for (const r of j.prompts) d[r.key] = r.content
      setDrafts(d)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Reset failed')
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-600/40 bg-slate-950/40 p-4 text-sm text-slate-500">
        Loading pipeline prompts…
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-b from-cyan-950/20 to-slate-950/50 p-4 sm:p-5 max-w-5xl space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-cyan-200/95">Edit pipeline fragments</h3>
          <p className="text-[11px] text-slate-500 mt-1 max-w-2xl leading-relaxed">
            Backend merges these with live text. Expand a row to edit; overrides live in{' '}
            <code className="text-slate-600">data/prompt_overrides.json</code>.
          </p>
          <p className="text-[10px] text-slate-600 mt-2">
            {stats.total} keys · {stats.customized} saved override{stats.customized === 1 ? '' : 's'} ·{' '}
            {stats.dirty} unsaved edit{stats.dirty === 1 ? '' : 's'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onResetAll()}
          className="shrink-0 text-xs font-medium rounded-lg border border-slate-600/60 bg-slate-900/50 px-2.5 py-1.5 text-slate-300 hover:bg-white/[0.05] self-start"
        >
          Reset all overrides
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center rounded-xl border border-white/[0.06] bg-slate-950/40 p-2 sm:p-2.5">
        <div className="relative flex-1 min-w-[12rem] max-w-md">
          <label htmlFor="pipeline-prompt-search" className="sr-only">
            Search pipeline prompts
          </label>
          <input
            id="pipeline-prompt-search"
            type="search"
            autoComplete="off"
            placeholder="Search by title, key, or description…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-600/60 bg-slate-900/90 py-2 pl-2.5 pr-8 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/35"
          />
          {searchQuery ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-300 text-[10px]"
            >
              ✕
            </button>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer shrink-0">
          <input
            type="checkbox"
            className="rounded border-slate-600 bg-slate-900 accent-cyan-500"
            checked={showTouchesOnly}
            onChange={(e) => setShowTouchesOnly(e.target.checked)}
          />
          Overrides &amp; unsaved only
        </label>
        <div className="flex flex-wrap gap-1.5 sm:ml-auto">
          <button
            type="button"
            onClick={expandAllCategories}
            className="text-[11px] font-medium rounded-md border border-slate-600/50 px-2 py-1 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
          >
            Open all sections
          </button>
          <button
            type="button"
            onClick={expandAllPromptEditors}
            className="text-[11px] font-medium rounded-md border border-slate-600/50 px-2 py-1 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
          >
            Expand all editors
          </button>
          <button
            type="button"
            onClick={collapseAllPromptEditors}
            className="text-[11px] font-medium rounded-md border border-slate-600/50 px-2 py-1 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
          >
            Collapse editors
          </button>
        </div>
      </div>

      {err && (
        <p className="text-xs text-amber-200/95 border border-amber-500/25 rounded-lg px-2 py-1.5">{err}</p>
      )}

      {groupedFiltered.length === 0 ? (
        <p className="text-sm text-slate-500 rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-6 text-center">
          No prompts match. Clear search or turn off the filter.
        </p>
      ) : (
        <div className="space-y-3">
          {groupedFiltered.map(([cat, rows]) => {
            const catCollapsed = collapsedCats.has(cat)
            const overrideCount = rows.filter((r) => !r.is_default).length
            const dirtyCount = rows.filter((r) => (drafts[r.key] ?? '') !== r.content).length
            return (
              <section
                key={cat}
                className="rounded-xl border border-white/[0.08] bg-slate-900/35 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleCat(cat)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
                  aria-expanded={!catCollapsed}
                >
                  <span className="text-slate-500 text-[10px] w-4 shrink-0 tabular-nums">
                    {catCollapsed ? '▶' : '▼'}
                  </span>
                  <span className="text-xs font-semibold text-slate-200 flex-1 min-w-0">{cat}</span>
                  <span className="text-[10px] text-slate-500 shrink-0 text-right">
                    {rows.length} prompt{rows.length === 1 ? '' : 's'}
                    {overrideCount ? (
                      <span className="text-cyan-200/75"> · {overrideCount} override</span>
                    ) : null}
                    {dirtyCount ? <span className="text-amber-200/85"> · {dirtyCount} unsaved</span> : null}
                  </span>
                </button>
                {!catCollapsed && (
                  <div className="border-t border-white/[0.06] space-y-2 p-2 sm:p-3 bg-black/10">
                    {rows.map((row) => {
                      const dirty = (drafts[row.key] ?? '') !== row.content
                      const open = expandedPrompts.has(row.key)
                      const draft = drafts[row.key] ?? ''
                      const lines = draft ? draft.split(/\r\n|\r|\n/).length : 0
                      const chars = draft.length
                      return (
                        <div
                          key={row.key}
                          className="rounded-lg border border-white/[0.06] bg-slate-950/50 overflow-hidden"
                        >
                          <div className="flex items-stretch gap-0 min-h-[2.75rem]">
                            <button
                              type="button"
                              onClick={() => togglePromptOpen(row.key)}
                              aria-expanded={open}
                              className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0 hover:bg-white/[0.04]"
                            >
                              <span className="text-slate-600 text-[10px] w-4 shrink-0" aria-hidden>
                                {open ? '▼' : '▶'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-medium text-slate-100 truncate">{row.title}</div>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                  <code className="text-[10px] text-slate-600 truncate max-w-[min(100%,14rem)]">
                                    {row.key}
                                  </code>
                                  <span className="text-[10px] text-slate-600">
                                    {lines} L · {chars} ch
                                  </span>
                                  {dirty ? (
                                    <span className="text-[10px] font-medium text-amber-200/90">Unsaved</span>
                                  ) : null}
                                  {!row.is_default ? (
                                    <span className="text-[10px] font-medium text-cyan-200/75">Override</span>
                                  ) : null}
                                </div>
                              </div>
                            </button>
                            <button
                              type="button"
                              title="Copy key"
                              onClick={() => void navigator.clipboard.writeText(row.key)}
                              className="shrink-0 px-2 text-[10px] font-medium text-slate-500 hover:text-cyan-300 hover:bg-white/[0.04] border-l border-white/[0.06]"
                            >
                              Copy key
                            </button>
                          </div>
                          {open ? (
                            <div className="border-t border-white/[0.06] p-3 space-y-2.5 bg-slate-950/80">
                              <p className="text-[11px] text-slate-500 leading-relaxed">{row.description}</p>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={!dirty || savingKey === row.key}
                                  onClick={() => void saveKey(row.key)}
                                  className="text-xs font-medium rounded-lg bg-cyan-600/90 hover:bg-cyan-500 disabled:opacity-40 px-2.5 py-1.5 text-white"
                                >
                                  {savingKey === row.key ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    savingKey === row.key || (drafts[row.key] ?? '') === row.content
                                  }
                                  onClick={() => {
                                    setDrafts((d) => ({ ...d, [row.key]: row.content }))
                                  }}
                                  className="text-xs font-medium rounded-lg border border-slate-600/60 px-2.5 py-1.5 text-slate-300 hover:bg-white/[0.05] disabled:opacity-40"
                                >
                                  Revert
                                </button>
                              </div>
                              <textarea
                                className="w-full min-h-[10rem] sm:min-h-[12rem] rounded-lg border border-slate-600/70 bg-slate-950/90 px-2.5 py-2 text-xs text-slate-100 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-cyan-500/40"
                                value={drafts[row.key] ?? ''}
                                onChange={(e) =>
                                  setDrafts((d) => ({ ...d, [row.key]: e.target.value }))
                                }
                                spellCheck={false}
                                aria-label={row.title}
                              />
                              <PromptRefineWidget
                                contextLabel={`Pipeline prompt: ${row.key} (${row.title})`}
                                currentText={drafts[row.key] ?? ''}
                                models={refineModels}
                                defaultModel={refineDefaultModel}
                                onApply={(text) =>
                                  setDrafts((d) => ({ ...d, [row.key]: text }))
                                }
                                compact
                              />
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function isValidNewCouncilId(s: string) {
  const t = s.trim()
  return t.length > 0 && t.length <= 64 && NEW_COUNCIL_ID_RE.test(t)
}

function AgentSystemPromptCard({
  roleLabel,
  agent,
  onChange,
  refineModels = [],
  refineDefaultModel = '',
  collapsible = false,
  expanded = true,
  onToggleExpand,
  registeredTools = [],
}: {
  roleLabel: string
  agent: AgentDef
  onChange: (patch: Partial<AgentDef>) => void
  refineModels?: string[]
  refineDefaultModel?: string
  /** Compact row header; editor opens when expanded (Council & roles tab). */
  collapsible?: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  registeredTools?: AgentToolDefinition[]
}) {
  const sp = agent.system_prompt ?? ''
  const lines = sp ? sp.split(/\r\n|\r|\n/).length : 0
  const chars = sp.length
  const registeredToolIds = useMemo(
    () => registeredTools.map((t) => t.id),
    [registeredTools],
  )
  const copyPrompt = useCallback(() => {
    if (!sp) return
    void navigator.clipboard.writeText(sp)
  }, [sp])

  const editor = (
    <>
      <label className="block text-xs text-slate-400">
        System prompt
        <textarea
          className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono leading-relaxed focus:outline-none focus:ring-1 focus:ring-violet-500/40 min-h-[12rem] sm:min-h-[14rem]"
          value={agent.system_prompt}
          onChange={(e) => onChange({ system_prompt: e.target.value })}
          spellCheck={false}
        />
      </label>
      <PromptRefineWidget
        contextLabel={`${roleLabel}: ${agent.name || agent.id} — system prompt`}
        currentText={agent.system_prompt ?? ''}
        models={refineModels}
        defaultModel={refineDefaultModel}
        onApply={(text) => onChange({ system_prompt: text })}
        compact
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>
          {lines} line{lines === 1 ? '' : 's'} · {chars} chars
        </span>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
        <input
          type="checkbox"
          className="rounded border-slate-600 bg-slate-950 text-violet-500 focus:ring-violet-500/40"
          checked={agent.tools_enabled}
          onChange={(e) => onChange({ tools_enabled: e.target.checked })}
        />
        Tools enabled (when the pipeline supports them)
      </label>
      <AgentToolPicker agent={agent} registeredTools={registeredTools} onChange={onChange} />
    </>
  )

  if (collapsible && onToggleExpand) {
    return (
      <div className="rounded-lg border border-white/[0.08] bg-slate-950/50 overflow-hidden">
        <div className="flex items-stretch min-h-[2.75rem]">
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className="flex-1 flex items-center gap-2 px-2.5 py-2 text-left min-w-0 hover:bg-white/[0.04]"
          >
            <span className="text-slate-600 text-[10px] w-4 shrink-0" aria-hidden>
              {expanded ? '▼' : '▶'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-400/90">
                {roleLabel}
              </div>
              <div className="text-xs font-medium text-slate-100 truncate">{agent.name || agent.id}</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                <code className="text-[10px] text-slate-600 truncate max-w-[min(100%,14rem)]">
                  {agent.id}
                </code>
                {agent.title ? (
                  <span className="text-[10px] text-slate-600 truncate max-w-[10rem]">{agent.title}</span>
                ) : null}
                <span className="text-[10px] text-slate-600">
                  {lines} L · {chars} ch
                </span>
                {agentHasEffectiveTools(agent, registeredToolIds) ? (
                  <span className="text-[10px] font-medium text-emerald-200/80">Tools</span>
                ) : null}
              </div>
            </div>
          </button>
          <button
            type="button"
            title="Copy routing id"
            onClick={() => void navigator.clipboard.writeText(agent.id)}
            className="shrink-0 px-2 text-[10px] font-medium text-slate-500 hover:text-violet-300 hover:bg-white/[0.04] border-l border-white/[0.06]"
          >
            Copy id
          </button>
          <button
            type="button"
            onClick={copyPrompt}
            disabled={!sp}
            className="shrink-0 px-2 text-[10px] font-medium text-slate-500 hover:text-violet-300 hover:bg-white/[0.04] border-l border-white/[0.06] disabled:opacity-30"
          >
            Copy prompt
          </button>
        </div>
        {expanded ? (
          <div className="border-t border-white/[0.06] p-4 space-y-3 bg-slate-950/80">{editor}</div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/[0.08] bg-slate-950/35 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-400/90">
            {roleLabel}
          </span>
          <h4 className="text-sm font-medium text-slate-100 mt-1">
            {agent.name || agent.id}
          </h4>
          <p className="text-[11px] text-slate-500 font-mono mt-0.5 truncate">
            {agent.id}
            {agent.title ? ` · ${agent.title}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={copyPrompt}
          disabled={!sp}
          className="shrink-0 text-xs font-medium text-violet-400 hover:text-violet-300 disabled:opacity-30"
        >
          Copy prompt
        </button>
      </div>
      {editor}
    </div>
  )
}

export type AgentsTabMode = 'agents' | 'prompts_pipeline' | 'prompts_council'

type AgentsTabProps = {
  mode?: AgentsTabMode
  refineModels?: string[]
  refineModel?: string
}

export function AgentsTab({
  mode = 'agents',
  refineModels = [],
  refineModel = '',
}: AgentsTabProps) {
  const [councilId, setCouncilId] = useState('default')
  const [councilIds, setCouncilIds] = useState<string[]>(['default'])
  const [config, setConfig] = useState<CouncilConfig | null>(null)
  const [baselineSig, setBaselineSig] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sel, setSel] = useState<Selection | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newCouncilName, setNewCouncilName] = useState('')
  const [createFromId, setCreateFromId] = useState('default')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [createDisplayName, setCreateDisplayName] = useState('')
  const [createNotes, setCreateNotes] = useState('')
  const [createTagsLine, setCreateTagsLine] = useState('')
  const [createArea, setCreateArea] = useState('')
  const [createAutofillPrompts, setCreateAutofillPrompts] = useState(false)
  const [createAutofillModel, setCreateAutofillModel] = useState('')
  const [createProgressMessage, setCreateProgressMessage] = useState('')
  const [councilVersions, setCouncilVersions] = useState<CouncilVersionRow[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsActionError, setVersionsActionError] = useState<string | null>(null)
  const [regeneratingCouncil, setRegeneratingCouncil] = useState(false)
  const [regenerateProgressMessage, setRegenerateProgressMessage] = useState('')
  const [regenerateModelPick, setRegenerateModelPick] = useState('')
  const [councilAgentPromptSearch, setCouncilAgentPromptSearch] = useState('')
  const [expandedCouncilAgentIds, setExpandedCouncilAgentIds] = useState<Set<string>>(
    () => new Set(),
  )
  const fileImportRef = useRef<HTMLInputElement>(null)
  const createProgressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const regenerateProgressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const configRef = useRef<CouncilConfig | null>(null)
  useEffect(() => {
    configRef.current = config
  }, [config])

  const [registeredTools, setRegisteredTools] = useState<AgentToolDefinition[]>([])
  useEffect(() => {
    let live = true
    void getTools()
      .then((t) => {
        if (live) setRegisteredTools(t)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const registeredToolIds = useMemo(
    () => registeredTools.map((x) => x.id),
    [registeredTools],
  )

  const stopCreateProgressTicker = useCallback(() => {
    if (createProgressIntervalRef.current != null) {
      clearInterval(createProgressIntervalRef.current)
      createProgressIntervalRef.current = null
    }
  }, [])

  useEffect(() => () => stopCreateProgressTicker(), [stopCreateProgressTicker])

  const stopRegenerateProgressTicker = useCallback(() => {
    if (regenerateProgressIntervalRef.current != null) {
      clearInterval(regenerateProgressIntervalRef.current)
      regenerateProgressIntervalRef.current = null
    }
  }, [])

  useEffect(() => () => stopRegenerateProgressTicker(), [stopRegenerateProgressTicker])

  useEffect(() => {
    if (!createOpen) {
      stopCreateProgressTicker()
      setCreateProgressMessage('')
    }
  }, [createOpen, stopCreateProgressTicker])

  useEffect(() => {
    setCouncilAgentPromptSearch('')
    setExpandedCouncilAgentIds(new Set())
  }, [councilId])

  const filteredCouncilAgentRows = useMemo(() => {
    if (!config) return [] as { agent: AgentDef; index: number }[]
    const q = councilAgentPromptSearch.trim().toLowerCase()
    return config.debating_agents
      .map((agent, index) => ({ agent, index }))
      .filter(({ agent }) => {
        if (!q) return true
        return (
          agent.id.toLowerCase().includes(q) ||
          agent.name.toLowerCase().includes(q) ||
          (agent.title || '').toLowerCase().includes(q) ||
          (agent.system_prompt || '').toLowerCase().includes(q)
        )
      })
  }, [config, councilAgentPromptSearch])

  const toggleCouncilAgentCard = useCallback((id: string) => {
    setExpandedCouncilAgentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const expandAllCouncilAgentCards = useCallback(() => {
    setExpandedCouncilAgentIds(
      new Set(filteredCouncilAgentRows.map(({ agent }) => agent.id)),
    )
  }, [filteredCouncilAgentRows])

  const collapseAllCouncilAgentCards = useCallback(() => {
    setExpandedCouncilAgentIds(new Set())
  }, [])

  const setConfigFromServer = useCallback((c: CouncilConfig) => {
    const next = mergeCouncilDefaults(c)
    setConfig(next)
    setBaselineSig(configSignature(next))
    setSel((prev) => {
      if (
        prev?.kind === 'debate' &&
        prev.index < next.debating_agents.length
      ) {
        return prev
      }
      if (next.debating_agents.length) {
        return { kind: 'debate', index: 0 }
      }
      return null
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
        const c = await getCouncil(councilId)
        setConfigFromServer(c)
        setSaveError(null)
        setSaved(false)
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : 'Failed to load council config'
        )
      }
    },
    [setConfigFromServer, config, baselineSig, councilId]
  )

  const onPickCouncil = useCallback(
    async (id: string) => {
      if (id === councilId) return
      if (config && baselineSig != null && configSignature(config) !== baselineSig) {
        if (
          !window.confirm(
            'You have unsaved changes. Switch council and lose local edits?'
          )
        ) {
          return
        }
      }
      setLoadError(null)
      setSaveError(null)
      setDeleteError(null)
      setSaved(false)
      setCouncilId(id)
      try {
        const c = await getCouncil(id)
        setConfigFromServer(c)
        const fresh = await listCouncils()
        if (fresh.length) setCouncilIds(fresh)
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : 'Failed to load council config'
        )
      }
    },
    [councilId, config, baselineSig, setConfigFromServer]
  )

  const onCreateCouncil = useCallback(async () => {
    const id = newCouncilName.trim()
    if (!isValidNewCouncilId(id)) {
      setCreateError(
        'Id: letter or number, then letters, numbers, _ or -, max 64 characters.'
      )
      return
    }
    const templateNone = createFromId === '__none__'
    if (!templateNone && id === createFromId) {
      setCreateError('New id must differ from the template council you copy from.')
      return
    }
    if (config && baselineSig != null && configSignature(config) !== baselineSig) {
      if (
        !window.confirm(
          'You have unsaved changes on the current profile. Create a new council file anyway?'
        )
      ) {
        return
      }
    }
    setCreateError(null)
    stopCreateProgressTicker()
    setCreateProgressMessage('')
    setCreating(true)
    if (createAutofillPrompts) {
      let step = 0
      setCreateProgressMessage(CREATE_MODAL_PROGRESS_AUTOFILL[0])
      createProgressIntervalRef.current = window.setInterval(() => {
        step = Math.min(step + 1, CREATE_MODAL_PROGRESS_AUTOFILL.length - 1)
        setCreateProgressMessage(CREATE_MODAL_PROGRESS_AUTOFILL[step])
      }, 2600)
    } else {
      setCreateProgressMessage('Creating council on the server…')
    }
    try {
      const res = await createCouncil({
        id,
        from_id: templateNone ? 'none' : createFromId,
        display_name: createDisplayName.trim() || null,
        notes: createNotes.trim() || null,
        tags: createTagsLine
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 48),
        area: createArea.trim() || null,
        autofill_prompts: createAutofillPrompts,
        model:
          createAutofillPrompts
            ? createAutofillModel.trim() || refineModel.trim() || null
            : null,
      })
      stopCreateProgressTicker()
      setCreateProgressMessage('Refreshing council list…')
      const fresh = await listCouncils()
      if (fresh.length) setCouncilIds(fresh)
      setCouncilId(id)
      setCreateProgressMessage('Loading council into the editor…')
      const c = await getCouncil(id)
      setConfigFromServer(c)
      setLoadError(null)
      setSaveError(null)
      setSaved(false)
      setCreateOpen(false)
      setNewCouncilName('')
      setCreateDisplayName('')
      setCreateNotes('')
      setCreateTagsLine('')
      setCreateArea('')
      setCreateAutofillPrompts(false)
      setCreateAutofillModel('')
      setDeleteError(null)
      if (res.autofill_error) {
        window.alert(
          `Council was created, but LLM prompt autofill did not complete:\n\n${res.autofill_error}`
        )
      }
    } catch (e) {
      setCreateError(
        e instanceof Error ? e.message : 'Failed to create council'
      )
    } finally {
      stopCreateProgressTicker()
      setCreating(false)
      setCreateProgressMessage('')
    }
  }, [
    newCouncilName,
    createFromId,
    config,
    baselineSig,
    setConfigFromServer,
    createDisplayName,
    createNotes,
    createTagsLine,
    createArea,
    createAutofillPrompts,
    createAutofillModel,
    refineModel,
    stopCreateProgressTicker,
  ])

  const onDeleteCurrentCouncil = useCallback(async () => {
    if (councilIds.length <= 1) return
    if (
      !window.confirm(
        `Delete council "${councilId}"? This removes the file on the server. This cannot be undone.`
      )
    ) {
      return
    }
    if (config && baselineSig != null && configSignature(config) !== baselineSig) {
      if (
        !window.confirm(
          'You have unsaved changes on this profile. They will be lost when the file is deleted. Continue?'
        )
      ) {
        return
      }
    }
    setDeleteError(null)
    setDeleting(true)
    try {
      await deleteCouncil(councilId)
      const fresh = await listCouncils()
      if (!fresh.length) {
        setLoadError(
          'No council files in config/councils/. Add a .json file or the default council.'
        )
        return
      }
      setCouncilIds(fresh)
      const nextId = fresh[0]!
      setCouncilId(nextId)
      const c = await getCouncil(nextId)
      setConfigFromServer(c)
      setLoadError(null)
      setSaveError(null)
      setSaved(false)
    } catch (e) {
      setDeleteError(
        e instanceof Error ? e.message : 'Failed to delete council'
      )
    } finally {
      setDeleting(false)
    }
  }, [
    councilId,
    councilIds.length,
    config,
    baselineSig,
    setConfigFromServer,
  ])

  useEffect(() => {
    let cancel = false
    void (async () => {
      try {
        const ids = await listCouncils()
        if (cancel) return
        if (!ids.length) {
          if (!cancel) {
            setLoadError(
              'No council files in config/councils/. Add a .json file or the default council.'
            )
          }
          return
        }
        setCouncilIds(ids)
        const pick = ids.includes('default') ? 'default' : ids[0]!
        if (!cancel) setCouncilId(pick)
        const c = await getCouncil(pick)
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

  const loadCouncilVersions = useCallback(async () => {
    setVersionsActionError(null)
    setVersionsLoading(true)
    try {
      const rows = await listCouncilVersions(councilId)
      setCouncilVersions(rows)
    } catch (e) {
      setVersionsActionError(
        e instanceof Error ? e.message : 'Could not load version history'
      )
      setCouncilVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }, [councilId])

  useEffect(() => {
    if (mode !== 'agents' && mode !== 'prompts_council') return
    void loadCouncilVersions()
  }, [councilId, mode, loadCouncilVersions])

  const updateDebater = useCallback((index: number, patch: Partial<AgentDef>) => {
    setConfig((c) => {
      if (!c) return c
      const next = [...c.debating_agents]
      next[index] = { ...next[index]!, ...patch }
      return { ...c, debating_agents: next }
    })
  }, [])

  const updateOrchestrator = useCallback((patch: Partial<AgentDef>) => {
    setConfig((c) => {
      if (!c) return c
      const base = mergeCouncilDefaults(c).orchestrator!
      return { ...c, orchestrator: { ...base, ...patch } }
    })
  }, [])

  const setOrchestratorUserInstructions = useCallback((text: string) => {
    setConfig((c) => (c ? { ...c, orchestrator_user_instructions: text } : c))
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
      taken.add(mergeCouncilDefaults(c).orchestrator!.id)
      const id = slugAgentId('new agent', taken)
      const fresh: AgentDef = {
        id,
        name: 'New agent',
        title: 'Perspective',
        system_prompt: '',
        tools_enabled: true,
        tool_ids: [],
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
      if (!config || config.debating_agents.length < 1) return
      if (!window.confirm('Remove this agent from the council?')) return
      setConfig((c) => {
        if (!c || index < 0 || index >= c.debating_agents.length) return c
        const list = c.debating_agents.filter((_, i) => i !== index)
        const next = { ...c, debating_agents: list }
        queueMicrotask(() => {
          setSel((prev) => {
            if (list.length === 0) {
              return null
            }
            if (prev?.kind === 'debate') {
              if (prev.index === index) {
                return {
                  kind: 'debate',
                  index: Math.min(index, list.length - 1),
                }
              }
              if (prev.index > index) {
                return { kind: 'debate', index: prev.index - 1 }
              }
            }
            return prev
          })
        })
        return next
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
        const taken = new Set(c.debating_agents.map((a) => a.id))
        taken.add(mergeCouncilDefaults(c).orchestrator!.id)
        const newId = slugAgentId(`${source.name} copy`, taken)
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
    if (!config) return
    setSaveError(null)
    setSaved(false)
    setSaving(true)
    try {
      const normalized = mergeCouncilDefaults(config)
      const toSave: CouncilConfig = {
        ...normalized,
        orchestrator_user_instructions:
          normalized.orchestrator_user_instructions?.trim() || undefined,
        output_instructions:
          normalized.output_instructions?.trim() || undefined,
        artifact_filename: normalized.artifact_filename?.trim() || undefined,
        display_name: normalized.display_name?.trim() || undefined,
        notes: normalized.notes?.trim() || undefined,
        tags: normalized.tags,
        area: normalized.area?.trim() || undefined,
        ...(normalized.initial_research === false
          ? { initial_research: false }
          : {}),
      }
      await putCouncil(toSave, councilId)
      setConfig(mergeCouncilDefaults(toSave))
      setBaselineSig(configSignature(toSave))
      setSaved(true)
      void loadCouncilVersions()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [config, councilId, loadCouncilVersions])

  const onRegenerateCouncilPrompts = useCallback(async () => {
    if (dirty) {
      window.alert(
        'Save the council first. Regenerate reads the file on the server, not unsaved editor changes.'
      )
      return
    }
    if (
      !window.confirm(
        'Snapshot the current saved council, then rerun AI on your profile and roster? This replaces orchestrator, specialist, and routing-guidelines text in the file. You can restore from version history.'
      )
    ) {
      return
    }
    setVersionsActionError(null)
    stopRegenerateProgressTicker()
    setRegenerateProgressMessage('')
    setRegeneratingCouncil(true)
    let step = 0
    setRegenerateProgressMessage(REGENERATE_COUNCIL_PROGRESS[0])
    regenerateProgressIntervalRef.current = window.setInterval(() => {
      step = Math.min(step + 1, REGENERATE_COUNCIL_PROGRESS.length - 1)
      setRegenerateProgressMessage(REGENERATE_COUNCIL_PROGRESS[step])
    }, 2800)
    try {
      const res = await regenerateCouncilPrompts(
        councilId,
        regenerateModelPick.trim() || refineModel.trim() || null
      )
      stopRegenerateProgressTicker()
      setRegenerateProgressMessage('Loading updated council…')
      const c = await getCouncil(councilId)
      setConfigFromServer(c)
      setSaveError(null)
      setSaved(false)
      await loadCouncilVersions()
      if (res.autofill_error) {
        window.alert(
          `Regenerate finished with issues:\n\n${res.autofill_error}\n\nCheck prompts manually or restore a snapshot.`
        )
      }
    } catch (e) {
      setVersionsActionError(e instanceof Error ? e.message : 'Regenerate failed')
    } finally {
      stopRegenerateProgressTicker()
      setRegeneratingCouncil(false)
      setRegenerateProgressMessage('')
    }
  }, [
    dirty,
    councilId,
    regenerateModelPick,
    refineModel,
    setConfigFromServer,
    loadCouncilVersions,
    stopRegenerateProgressTicker,
  ])

  const onRestoreCouncilVersion = useCallback(
    async (versionId: string) => {
      if (dirty) {
        window.alert(
          'Save or discard local edits first — restore updates from the server and replaces your editor buffer.'
        )
        return
      }
      if (
        !window.confirm(
          'Restore this snapshot? The live file will be snapshotted first, then replaced.'
        )
      ) {
        return
      }
      setVersionsActionError(null)
      try {
        await restoreCouncilVersion(councilId, versionId)
        const c = await getCouncil(councilId)
        setConfigFromServer(c)
        setSaveError(null)
        setSaved(false)
        await loadCouncilVersions()
      } catch (e) {
        setVersionsActionError(e instanceof Error ? e.message : 'Restore failed')
      }
    },
    [
      dirty,
      councilId,
      setConfigFromServer,
      loadCouncilVersions,
    ]
  )

  const onDeleteCouncilVersion = useCallback(
    async (versionId: string) => {
      if (!window.confirm('Delete this snapshot from history? The live council file is unchanged.')) {
        return
      }
      setVersionsActionError(null)
      try {
        await deleteCouncilVersion(councilId, versionId)
        await loadCouncilVersions()
      } catch (e) {
        setVersionsActionError(e instanceof Error ? e.message : 'Delete snapshot failed')
      }
    },
    [councilId, loadCouncilVersions]
  )

  const exportJson = useCallback(() => {
    if (!config) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(
      new Blob([councilConfigToJsonString(config)], {
        type: 'application/json;charset=utf-8',
      })
    )
    a.download = `council-${councilId}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [config, councilId])

  const onImportFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0]
      e.target.value = ''
      if (!f) return
      void f.text().then((text) => {
        const parsed = parseCouncilConfigText(text)
        if (!parsed) {
          window.alert(
            'Invalid council JSON: check debating_agents entries (id, name, fields) and overall shape.'
          )
          return
        }
        if (config && baselineSig != null && configSignature(config) !== baselineSig) {
          if (!window.confirm('You have unsaved edits. Replace council config with the imported file?')) {
            return
          }
        }
        const merged = mergeCouncilDefaults(parsed)
        setConfig(merged)
        setBaselineSig(configSignature(merged))
        setSaveError(null)
        setSaved(false)
        setSel(parsed.debating_agents.length ? { kind: 'debate', index: 0 } : null)
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
      if (e.key === 'Escape' && createOpen) {
        e.preventDefault()
        e.stopPropagation()
        if (creating) return
        stopCreateProgressTicker()
        setCreateOpen(false)
        return
      }
      if (e.key === 'Escape' && editorOpen) {
        e.preventDefault()
        e.stopPropagation()
        setEditorOpen(false)
        return
      }
      if (mode === 'prompts_pipeline' || mode === 'prompts_council') return
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
  }, [onNavAgent, editorOpen, createOpen, creating, mode, stopCreateProgressTicker])

  useEffect(() => {
    if (!editorOpen && !createOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [editorOpen, createOpen])

  const selectedAgent = useMemo(() => {
    if (!config || !sel) return null
    const ag = config.debating_agents[sel.index]
    if (!ag) return null
    return { index: sel.index, agent: ag }
  }, [config, sel])

  const councilAllIds = useMemo(() => {
    if (!config) return new Set<string>()
    const m = mergeCouncilDefaults(config)
    const s = new Set<string>()
    if (m.orchestrator) s.add(m.orchestrator.id)
    for (const a of m.debating_agents) s.add(a.id)
    return s
  }, [config])

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
  const orch = mergeCouncilDefaults(config).orchestrator!
  const canRemoveDebate = debaters.length >= 1

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

  const showAgents = mode === 'agents'
  const showPipelinePrompts = mode === 'prompts_pipeline'
  const showCouncilPrompts = mode === 'prompts_council'
  const showCouncilToolbar = mode === 'agents' || mode === 'prompts_council'

  return (
    <div className="space-y-4 pb-8">
      {showPipelinePrompts && (
        <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
          <span className="text-cyan-200/90 font-medium">Pipeline defaults</span> are backend fragments (not full
          prompts). Use search and sections below; open the reference for how keys compose.
        </p>
      )}
      {showCouncilPrompts && (
        <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
          <span className="text-amber-200/90 font-medium">Council &amp; roles</span> — saved in{' '}
          <code className="text-slate-500">config/councils/&lt;id&gt;.json</code>. Use sections below; routing JSON
          shape is under <span className="text-cyan-200/80">Pipeline defaults</span>.
        </p>
      )}
      {showAgents && (
        <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
          <span className="text-violet-300/90 font-medium">Council agents</span> — graph order, routing ids, tools,
          and full prompts in the editor. For orchestrator wording without the graph, use{' '}
          <span className="text-slate-300">Council &amp; roles</span>.
        </p>
      )}

      {showCouncilToolbar && (
      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3 rounded-xl border border-white/[0.08] bg-slate-900/30 px-3 py-2.5">
        <label className="flex items-center gap-2 text-xs text-slate-400 shrink-0 min-w-0 max-w-full sm:max-w-[12rem]">
          <span className="shrink-0">Editing</span>
          <select
            className="min-w-0 flex-1 text-xs py-1.5 px-2 rounded-lg border border-slate-600/60 bg-slate-900/80 text-slate-100"
            value={councilId}
            onChange={(e) => {
              void onPickCouncil(e.target.value)
            }}
            title="Which council file to view and save"
            aria-label="Council profile"
          >
            {councilIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setCreateError(null)
            setDeleteError(null)
            setNewCouncilName('')
            setCreateDisplayName('')
            setCreateNotes('')
            setCreateTagsLine('')
            setCreateArea('')
            setCreateAutofillPrompts(false)
            setCreateAutofillModel(refineModel)
            setCreateFromId(councilId)
            setCreateOpen(true)
          }}
          className="shrink-0 text-xs font-medium rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-1.5 text-violet-200 hover:bg-violet-500/20"
        >
          New council…
        </button>
        <button
          type="button"
          onClick={() => void onDeleteCurrentCouncil()}
          disabled={councilIds.length <= 1 || deleting}
          className="shrink-0 text-xs font-medium rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-rose-200 hover:bg-rose-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
          title={
            councilIds.length <= 1
              ? 'At least one council must remain'
              : `Delete config/councils/${councilId}.json on the server`
          }
        >
          {deleting ? 'Deleting…' : 'Delete…'}
        </button>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {deleteError && (
            <span className="text-xs text-amber-200/95 max-w-[12rem] sm:max-w-none" title={deleteError}>
              {deleteError}
            </span>
          )}
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
      )}

      {showCouncilToolbar && config && (
        <details
          className="rounded-2xl border border-slate-600/30 bg-slate-900/25 max-w-5xl open:bg-slate-900/35"
          open
        >
          <summary className="cursor-pointer px-4 py-3 text-sm text-slate-400 hover:text-slate-200 marker:text-slate-600">
            <span className="text-slate-200 font-medium">Council profile</span>
            <span className="text-slate-500">
              {' '}
              — display name, notes, tags, domain (saved in council JSON; used for LLM autofill context)
            </span>
          </summary>
          <div className="px-4 pb-4 sm:px-5 border-t border-white/[0.06] pt-4 space-y-3 max-w-3xl">
            <p className="text-[11px] text-slate-500 leading-relaxed">
              Edit the blueprint for this council. When you create a council with autofill, these fields are sent to
              the prompts under <span className="text-cyan-200/80">Pipeline defaults</span> →{' '}
              <span className="text-slate-400">Council bootstrap</span>.
            </p>
            <label className="block text-xs text-slate-400">
              Display name
              <input
                type="text"
                className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
                value={config.display_name ?? ''}
                onChange={(e) =>
                  setConfig((c) => (c ? { ...c, display_name: e.target.value } : c))
                }
                placeholder="e.g. Security review council"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Area / domain
              <input
                type="text"
                className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
                value={config.area ?? ''}
                onChange={(e) => setConfig((c) => (c ? { ...c, area: e.target.value } : c))}
                placeholder="e.g. AppSec, hiring, product strategy"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Tags <span className="text-slate-600">(comma-separated)</span>
              <input
                type="text"
                className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/40"
                value={(config.tags ?? []).join(', ')}
                onChange={(e) => {
                  const tags = e.target.value
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .slice(0, 48)
                  setConfig((c) => (c ? { ...c, tags } : c))
                }}
                placeholder="research, compliance, codegen"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Notes
              <textarea
                className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/40 min-h-[5rem]"
                value={config.notes ?? ''}
                onChange={(e) => setConfig((c) => (c ? { ...c, notes: e.target.value } : c))}
                placeholder="Mission, constraints, links, or anything future agents should respect."
                spellCheck={true}
              />
            </label>

            <div className="pt-4 mt-3 border-t border-white/[0.08] space-y-4 max-w-3xl">
              <div>
                <h4 className="text-xs font-semibold text-slate-300">Regenerate prompts (AI)</h4>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                  Reruns <span className="text-slate-400">Council bootstrap</span> on the{' '}
                  <strong className="text-slate-400">saved</strong> file, using your profile fields and current roster.
                  Snapshots are stored under <code className="text-slate-600">data/council_versions/</code> (see
                  below).
                </p>
                <label className="block text-xs text-slate-400 mt-2">
                  Model
                  <select
                    className="mt-1 w-full max-w-md text-sm py-2 px-2 rounded-lg border border-slate-600/60 bg-slate-900/80 text-slate-100"
                    value={regenerateModelPick || refineModel || ''}
                    onChange={(e) => setRegenerateModelPick(e.target.value)}
                    disabled={regeneratingCouncil || saving}
                  >
                    {(() => {
                      const opts =
                        refineModels.length > 0
                          ? refineModels
                          : refineModel
                            ? [refineModel]
                            : []
                      if (opts.length === 0) {
                        return <option value="">Provider default</option>
                      }
                      return opts.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    })()}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void onRegenerateCouncilPrompts()}
                  disabled={regeneratingCouncil || saving}
                  className="mt-2 text-xs font-medium rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-40"
                >
                  {regeneratingCouncil ? 'Regenerating…' : 'Regenerate with AI'}
                </button>
                {regeneratingCouncil && regenerateProgressMessage ? (
                  <div
                    className="mt-3 space-y-2 rounded-xl border border-cyan-500/25 bg-cyan-950/20 px-3 py-3"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin"
                        aria-hidden
                      />
                      <p className="text-xs text-cyan-100/95 leading-relaxed">{regenerateProgressMessage}</p>
                    </div>
                    <div className="council-create-progress-track" aria-hidden>
                      <div className="council-create-progress-fill" />
                    </div>
                  </div>
                ) : null}
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-300">Version history</h4>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                  Automatic snapshots before each save or AI regenerate. Restore rolls back the live file (current
                  state is snapshotted first). Delete removes only the snapshot file.
                </p>
                {versionsActionError ? (
                  <p className="mt-2 text-xs text-amber-200/95">{versionsActionError}</p>
                ) : null}
                {versionsLoading ? (
                  <p className="mt-2 text-xs text-slate-500">Loading snapshots…</p>
                ) : councilVersions.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-600">No snapshots yet — save or regenerate to create one.</p>
                ) : (
                  <ul className="mt-2 space-y-2 max-h-48 overflow-y-auto rounded-lg border border-white/[0.06] bg-slate-950/40 p-2">
                    {councilVersions.map((v) => (
                      <li
                        key={v.id}
                        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-md px-2 py-2 text-xs border border-transparent hover:border-white/[0.06]"
                      >
                        <div className="min-w-0">
                          <div className="text-slate-200 font-medium truncate">{v.label}</div>
                          <div className="text-[10px] text-slate-600 font-mono truncate mt-0.5">{v.id}</div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {new Date(v.created_at * 1000).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => void onRestoreCouncilVersion(v.id)}
                            disabled={regeneratingCouncil || saving || versionsLoading}
                            className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-violet-200 hover:bg-violet-500/20 disabled:opacity-40"
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteCouncilVersion(v.id)}
                            disabled={regeneratingCouncil || saving || versionsLoading}
                            className="rounded-md border border-slate-600/50 px-2 py-1 text-slate-400 hover:bg-white/[0.05] disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </details>
      )}

      {showCouncilToolbar && config && (
        showCouncilPrompts ? (
          <details
            className="rounded-2xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/20 to-slate-950/50 max-w-5xl open:bg-emerald-950/10"
            open
          >
            <summary className="cursor-pointer px-4 py-3 text-sm text-slate-400 hover:text-slate-200 marker:text-slate-600">
              <span className="text-emerald-200/95 font-medium">Primary output</span>
              <span className="text-slate-500 font-normal">
                {' '}
                — plan / report / code / none &amp; filename
              </span>
            </summary>
            <div className="px-4 pb-4 sm:px-5 border-t border-white/[0.06]">
              <CouncilOutputSettings config={config} setConfig={setConfig} />
            </div>
          </details>
        ) : (
          <CouncilOutputSettings config={config} setConfig={setConfig} />
        )
      )}

      {showAgents && (
        <p className="text-[11px] text-slate-500">
          Tip: <kbd className="kbd-hint">Alt</kbd> + <kbd className="kbd-hint">↑</kbd> /{' '}
          <kbd className="kbd-hint">↓</kbd> to change selection; click a node to open the editor.{' '}
          <kbd className="kbd-hint">Esc</kbd> closes the editor.
        </p>
      )}

      {showPipelinePrompts && (
        <>
          <details className="rounded-2xl border border-white/[0.08] bg-slate-900/25 max-w-5xl open:bg-slate-900/35">
            <summary className="cursor-pointer px-4 py-3 text-sm text-slate-400 hover:text-slate-200 marker:text-slate-600">
              <span className="text-slate-300 font-medium">Reference</span>
              <span className="text-slate-500"> — how pipeline keys combine (optional)</span>
            </summary>
            <div className="px-4 pb-4 pt-0 border-t border-white/[0.06]">
              <PromptPipelineMap />
            </div>
          </details>
          <PipelineBuiltinPrompts
            refineModels={refineModels}
            refineDefaultModel={refineModel}
          />
        </>
      )}

      {showCouncilPrompts && (
        <details
          className="rounded-2xl border border-amber-500/25 bg-gradient-to-b from-amber-950/25 to-slate-950/50 max-w-5xl open:shadow-sm"
          open
        >
          <summary className="cursor-pointer px-4 py-3 text-sm text-slate-400 hover:text-slate-200 marker:text-slate-600">
            <span className="text-amber-200/95 font-medium">Orchestrator &amp; routing</span>
            <span className="text-slate-500 font-normal">
              {' '}
              — <code className="text-slate-600 text-[11px]">{orch.id}</code> · system + guidelines
            </span>
          </summary>
          <div className="px-4 pb-4 sm:px-5 space-y-3 border-t border-white/[0.06]">
            <p className="text-[11px] text-slate-500 leading-relaxed pt-3">
              Routing action JSON lives under{' '}
              <span className="text-cyan-200/80">Pipeline defaults</span> → Orchestrator — action JSON schema. Leave
              routing guidelines empty to use the backend default.
            </p>
        <label className="flex items-start gap-2.5 text-xs text-slate-400 cursor-pointer max-w-3xl">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-slate-600 bg-slate-950 text-amber-500 focus:ring-amber-500/40"
            checked={config.initial_research !== false}
            onChange={(e) =>
              setConfig((prev) =>
                prev
                  ? { ...prev, initial_research: e.target.checked }
                  : prev
              )
            }
          />
            <span className="leading-relaxed">
            <span className="text-slate-300 font-medium">Prefer web research</span> when it helps —
            soft nudge in the orchestrator prompt to choose <code className="text-slate-600">run_research</code>{' '}
            early for grounding. Uncheck to nudge minimal web use; the orchestrator still decides each step
            (nothing runs before its first choice).
          </span>
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">
            Display name
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
              value={orch.name}
              onChange={(e) => updateOrchestrator({ name: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-400">
            Title
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
              value={orch.title}
              onChange={(e) => updateOrchestrator({ title: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-400 sm:col-span-2">
            Agent id{' '}
            <span className="text-slate-600 font-normal">(stable in logs; change with care)</span>
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/40"
              value={orch.id}
              onChange={(e) => updateOrchestrator({ id: e.target.value.trim() || orch.id })}
            />
          </label>
        </div>
        <label className="block text-xs text-slate-400">
          System prompt
          <textarea
            className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 leading-relaxed focus:outline-none focus:ring-1 focus:ring-amber-500/40 min-h-[6rem] sm:min-h-[7rem]"
            value={orch.system_prompt}
            onChange={(e) => updateOrchestrator({ system_prompt: e.target.value })}
          />
        </label>
        <PromptRefineWidget
          contextLabel="Orchestrator system prompt (council)"
          currentText={orch.system_prompt ?? ''}
          models={refineModels}
          defaultModel={refineModel}
          onApply={(text) => updateOrchestrator({ system_prompt: text })}
          compact
        />
        <label className="block text-xs text-slate-400">
          Routing guidelines (user message)
          <textarea
            className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 leading-relaxed focus:outline-none focus:ring-1 focus:ring-amber-500/40 min-h-[8rem] sm:min-h-[10rem] font-mono text-[13px]"
            value={config.orchestrator_user_instructions ?? ''}
            onChange={(e) => setOrchestratorUserInstructions(e.target.value)}
            placeholder="Leave empty to use defaults from backend/app/prompts/orchestrator.py"
          />
        </label>
        <PromptRefineWidget
          contextLabel="Orchestrator routing guidelines (user message)"
          currentText={config.orchestrator_user_instructions ?? ''}
          models={refineModels}
          defaultModel={refineModel}
          onApply={(text) => setOrchestratorUserInstructions(text)}
          compact
        />
          </div>
        </details>
      )}

      {showCouncilPrompts && (
        <div className="space-y-3 max-w-5xl">
          <div className="rounded-2xl border border-violet-500/25 bg-gradient-to-b from-violet-950/25 to-slate-950/50 p-4 sm:p-5 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-violet-200/95">Council agent prompts</h3>
              <p className="text-[11px] text-slate-500 mt-1 max-w-2xl leading-relaxed">
                Expand a row to edit system prompt and tools. Add or reorder agents in the{' '}
                <span className="text-slate-400">Council agents</span> tab.
              </p>
              {debaters.length > 0 ? (
                <p className="text-[10px] text-slate-600 mt-2">
                  {debaters.length} agent{debaters.length === 1 ? '' : 's'}
                  {councilAgentPromptSearch.trim()
                    ? ` · ${filteredCouncilAgentRows.length} match`
                    : null}
                </p>
              ) : null}
            </div>
            {debaters.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-slate-500">
                No council agents yet. Add them under{' '}
                <span className="text-slate-300">Council agents</span>, then edit their prompts here.
              </div>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center rounded-xl border border-white/[0.06] bg-slate-950/40 p-2 sm:p-2.5">
                  <div className="relative flex-1 min-w-[12rem] max-w-md">
                    <label htmlFor="council-agent-prompt-search" className="sr-only">
                      Search agents
                    </label>
                    <input
                      id="council-agent-prompt-search"
                      type="search"
                      autoComplete="off"
                      placeholder="Search by name, id, title, or prompt text…"
                      value={councilAgentPromptSearch}
                      onChange={(e) => setCouncilAgentPromptSearch(e.target.value)}
                      className="w-full rounded-lg border border-slate-600/60 bg-slate-900/90 py-2 pl-2.5 pr-8 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500/35"
                    />
                    {councilAgentPromptSearch ? (
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setCouncilAgentPromptSearch('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-300 text-[10px]"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-1.5 sm:ml-auto">
                    <button
                      type="button"
                      onClick={expandAllCouncilAgentCards}
                      className="text-[11px] font-medium rounded-md border border-slate-600/50 px-2 py-1 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      onClick={collapseAllCouncilAgentCards}
                      className="text-[11px] font-medium rounded-md border border-slate-600/50 px-2 py-1 text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                    >
                      Collapse all
                    </button>
                  </div>
                </div>
                {filteredCouncilAgentRows.length === 0 ? (
                  <p className="text-sm text-slate-500 rounded-xl border border-dashed border-white/10 bg-black/15 px-4 py-6 text-center">
                    No agents match. Clear the search.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {filteredCouncilAgentRows.map(({ agent: ag, index: i }) => (
                      <AgentSystemPromptCard
                        key={ag.id}
                        collapsible
                        expanded={expandedCouncilAgentIds.has(ag.id)}
                        onToggleExpand={() => toggleCouncilAgentCard(ag.id)}
                        roleLabel={`Agent ${i + 1}`}
                        agent={ag}
                        onChange={(p) => updateDebater(i, p)}
                        refineModels={refineModels}
                        refineDefaultModel={refineModel}
                        registeredTools={registeredTools}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="rounded-2xl border border-white/10 bg-slate-900/20 p-4 sm:p-5">
            {saveToServerRow}
          </div>
        </div>
      )}

      {/* Graph — full width so the page does not feel cramped */}
      {showAgents && (
        <>
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
              + Add agent
            </button>
            </div>
          </div>

          <div className="flex flex-col items-stretch min-w-[min(100%,18rem)]">
            <p className="text-[9px] text-slate-500 mb-2">
              1 · Council agents (optional; orchestrator routes via <code className="text-slate-600">call_agents</code>)
            </p>
            <div className="flex flex-wrap justify-center sm:flex-nowrap sm:justify-center items-center gap-y-2 gap-x-0">
              {debaters.length === 0 ? (
                <p className="text-center text-xs text-slate-500 py-4 px-3 max-w-md leading-relaxed">
                  No council agents yet. Use{' '}
                  <span className="text-violet-300 font-medium">+ Add agent</span> to add fully configurable roles
                  (name, routing id, system prompt, tools). Optional: you can run orchestrator-only — no agents — and
                  still use research and chat-only or artifact modes.
                </p>
              ) : (
                debaters.map((ag, i) => (
                  <div key={ag.id} className="flex items-center">
                    {i > 0 && <EdgeH />}
                    <GraphNode
                      label={ag.name}
                      subtitle={ag.title}
                      id={ag.id}
                      tools={agentHasEffectiveTools(ag, registeredToolIds)}
                      step={i + 1}
                      selected={sel?.kind === 'debate' && sel.index === i}
                      onSelect={() => {
                        setSel({ kind: 'debate', index: i })
                        setSaved(false)
                        setEditorOpen(true)
                      }}
                    />
                  </div>
                ))
              )}
            </div>

            <p className="text-center text-[10px] text-slate-500 mt-2 max-w-md mx-auto leading-relaxed">
              The orchestrator (edited above) routes each step. Add any number of agents; use{' '}
              <code className="text-slate-600">call_agents</code> in routing guidelines to run them. Optional output
              modes (plan / report / code) use shared backend formatters after discussion — not separate council
              personas.
            </p>
          </div>

          <ul className="mt-4 space-y-1.5 text-[10px] text-slate-500 border-t border-white/5 pt-3">
            <li>
              <span className="text-emerald-400/80">tools</span> chip: this agent has at least one registered
              capability in its prompt (or all, when the saved list is empty). Orchestrator{' '}
              <code className="text-slate-600">run_research</code> is separate.
            </li>
            <li>
              Routing ids are stable in logs and orchestrator JSON (not random — derived from name or a slug).
              Edit them in the agent panel; display name is separate.
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/20 p-4 sm:p-5 max-w-5xl">
          {saveToServerRow}
        </div>
        </>
      )}

        {showAgents && editorOpen &&
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
                    idContext={{ allIds: councilAllIds }}
                    refineModels={refineModels}
                    refineDefaultModel={refineModel}
                    refineContextLabel={`Agent ${selectedAgent.index + 1} system prompt`}
                    registeredTools={registeredTools}
                  />
                </div>

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

        {createOpen &&
          createPortal(
            <div
              className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center p-0 sm:p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="council-new-title"
              aria-busy={creating}
            >
              <button
                type="button"
                className="absolute inset-0 bg-black/70 backdrop-blur-sm disabled:cursor-wait"
                aria-label="Close"
                disabled={creating}
                onClick={() => {
                  if (creating) return
                  stopCreateProgressTicker()
                  setCreateOpen(false)
                }}
              />
              <div
                className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl border border-white/10 bg-[#0c0e16] p-4 shadow-2xl sm:rounded-2xl sm:mt-0"
                onClick={(e) => e.stopPropagation()}
              >
                <h2
                  id="council-new-title"
                  className="text-base font-semibold text-slate-100"
                >
                  New council
                </h2>
                <p className="mt-1 text-xs text-slate-500 leading-relaxed">
                  Creates <code className="text-slate-400">config/councils/&lt;id&gt;.json</code>.
                  Choose <span className="text-slate-400">None</span> for orchestrator-only starter
                  (no specialists); otherwise copy from an existing profile. Optional metadata is stored in the file
                  and passed to <span className="text-cyan-200/80">Council bootstrap</span> prompts when you autofill.
                </p>
                <div className="mt-4 space-y-3">
                  <label className="block text-xs text-slate-400">
                    New id
                    <input
                      type="text"
                      className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      value={newCouncilName}
                      onChange={(e) => setNewCouncilName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !creating) {
                          e.preventDefault()
                          void onCreateCouncil()
                        }
                      }}
                      placeholder="e.g. my_council"
                      autoComplete="off"
                      autoFocus
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Display name <span className="text-slate-600">(optional)</span>
                    <input
                      type="text"
                      className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      value={createDisplayName}
                      onChange={(e) => setCreateDisplayName(e.target.value)}
                      placeholder="Human-readable title (defaults to id for LLM context)"
                      autoComplete="off"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Copy from
                    <select
                      className="mt-1 w-full text-sm py-2 px-2 rounded-lg border border-slate-600/60 bg-slate-900/80 text-slate-100"
                      value={createFromId}
                      onChange={(e) => setCreateFromId(e.target.value)}
                    >
                      <option value="__none__">
                        None — orchestrator only (add agents after)
                      </option>
                      {councilIds.map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-slate-400">
                    Area / domain <span className="text-slate-600">(optional)</span>
                    <input
                      type="text"
                      className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      value={createArea}
                      onChange={(e) => setCreateArea(e.target.value)}
                      placeholder="e.g. product security, research ops"
                      autoComplete="off"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Tags <span className="text-slate-600">(comma-separated, optional)</span>
                    <input
                      type="text"
                      className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      value={createTagsLine}
                      onChange={(e) => setCreateTagsLine(e.target.value)}
                      placeholder="research, codegen, review"
                      autoComplete="off"
                    />
                  </label>
                  <label className="block text-xs text-slate-400">
                    Notes <span className="text-slate-600">(optional)</span>
                    <textarea
                      className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500/50 min-h-[4.5rem]"
                      value={createNotes}
                      onChange={(e) => setCreateNotes(e.target.value)}
                      placeholder="Mission, constraints, or context for humans and the autofill model."
                    />
                  </label>
                  <label className="flex items-start gap-2.5 text-xs text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border-slate-600 bg-slate-950 text-violet-500 focus:ring-violet-500/40"
                      checked={createAutofillPrompts}
                      onChange={(e) => setCreateAutofillPrompts(e.target.checked)}
                    />
                    <span>
                      <span className="text-slate-200 font-medium">Autofill prompts with LLM</span>
                      <span className="block text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                        Drafts orchestrator and specialist system prompts from the name, metadata, and template roster.
                        Editable under Pipeline defaults → Council bootstrap. Requires a working model.
                      </span>
                    </span>
                  </label>
                  {createAutofillPrompts ? (
                    <label className="block text-xs text-slate-400">
                      Model for autofill
                      <select
                        className="mt-1 w-full text-sm py-2 px-2 rounded-lg border border-slate-600/60 bg-slate-900/80 text-slate-100"
                        value={createAutofillModel || refineModel || ''}
                        onChange={(e) => setCreateAutofillModel(e.target.value)}
                      >
                        {(() => {
                          const opts =
                            refineModels.length > 0
                              ? refineModels
                              : refineModel
                                ? [refineModel]
                                : []
                          if (opts.length === 0) {
                            return (
                              <option value="">Provider default (from server)</option>
                            )
                          }
                          return opts.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))
                        })()}
                      </select>
                      <span className="block text-[10px] text-slate-600 mt-1">
                        Matches the main header model when you pick the same name; leave as-is or choose another
                        installed model.
                      </span>
                    </label>
                  ) : null}
                </div>
                {createError && (
                  <p className="mt-3 text-xs text-amber-200/95">{createError}</p>
                )}
                {creating && createProgressMessage ? (
                  <div
                    className="mt-4 space-y-2.5 rounded-xl border border-violet-500/30 bg-violet-950/25 px-3 py-3"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-violet-400 border-t-transparent animate-spin"
                        aria-hidden
                      />
                      <p className="text-xs text-violet-100/95 leading-relaxed min-w-0">
                        {createProgressMessage}
                      </p>
                    </div>
                    <div className="council-create-progress-track" aria-hidden>
                      <div className="council-create-progress-fill" />
                    </div>
                    {createAutofillPrompts ? (
                      <p className="text-[10px] text-slate-500 leading-snug">
                        You can keep this dialog open — closing is disabled until creation finishes.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreateOpen(false)}
                    className="text-sm font-medium text-slate-400 hover:text-slate-200"
                    disabled={creating}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void onCreateCouncil()}
                    disabled={creating || !newCouncilName.trim()}
                    className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-3 py-2 text-sm font-medium text-white"
                  >
                    {creating ? 'Creating…' : 'Create'}
                  </button>
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
  idContext,
  refineModels = [],
  refineDefaultModel = '',
  refineContextLabel = 'Agent system prompt',
  registeredTools = [],
}: {
  agent: AgentDef
  onChange: (p: Partial<AgentDef>) => void
  promptMinH: string
  /** When set, show routing id + slug helper (orchestrator roster ids). */
  idContext?: { allIds: Set<string> }
  refineModels?: string[]
  refineDefaultModel?: string
  refineContextLabel?: string
  registeredTools?: AgentToolDefinition[]
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
      {idContext && (
        <div className="rounded-lg border border-violet-500/20 bg-slate-900/35 px-2.5 py-2.5 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs text-slate-500 flex-1 min-w-[10rem]">
              Routing id
              <input
                type="text"
                className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                autoComplete="off"
                spellCheck={false}
                value={agent.id}
                onChange={(e) => onChange({ id: e.target.value.trim() || agent.id })}
                aria-label="Routing id for orchestrator and logs"
              />
            </label>
            <button
              type="button"
              className="shrink-0 text-xs font-medium rounded-lg border border-violet-500/40 bg-violet-500/10 px-2.5 py-2 text-violet-200 hover:bg-violet-500/20"
              onClick={() => {
                const next = slugAgentId(agent.name || 'agent', idContext.allIds, agent.id)
                onChange({ id: next })
              }}
            >
              Slug from name
            </button>
          </div>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Stable id referenced in activity and <code className="text-slate-600">call_agents</code> JSON.
            Display name above is only for the UI transcript.
          </p>
        </div>
      )}
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
        <PromptRefineWidget
          contextLabel={`${refineContextLabel}: ${agent.name || agent.id}`}
          currentText={agent.system_prompt ?? ''}
          models={refineModels}
          defaultModel={refineDefaultModel}
          onApply={(text) => onChange({ system_prompt: text })}
          compact
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
      <AgentToolPicker agent={agent} registeredTools={registeredTools} onChange={onChange} />
    </div>
  )
}
