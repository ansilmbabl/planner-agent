import { useEffect, useState } from 'react'
import type { HealthResponse } from '../api'
import { getPreferences, putPreferences } from '../api'
import { AgentsTab } from './AgentsTab'
import { HistoryMemoryTab } from './HistoryMemoryTab'
import { SettingsFlowOverview } from './SettingsFlowOverview'

type SettingsPanelProps = {
  health: HealthResponse | null
  modelHint: string | null
  ollamaHostReachable: boolean
  onRefresh: () => void
  busy: boolean
  onBack: () => void
  onOpenSidebar?: () => void
  /** Models for prompt refinement (same list as main header). */
  models: string[]
  /** Default model for refine calls (main header selection). */
  selectedModel: string
  /** When bulk-deleting chats from History, parent can clear the active session if removed. */
  onSessionsBulkDeleted?: (ids: string[]) => void
  activeTab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
}

export type SettingsTab =
  | 'flow'
  | 'connection'
  | 'prompts_pipeline'
  | 'prompts_council'
  | 'agents'
  | 'history'

function NavButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  label: string
  hint?: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`w-full text-left rounded-lg px-3 py-2 transition-colors ${
        active
          ? 'bg-violet-500/20 text-violet-50 ring-1 ring-violet-500/35'
          : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
      }`}
    >
      <span className="block text-sm font-medium">{label}</span>
      {hint ? (
        <span className="block text-[10px] text-slate-500 mt-0.5 leading-snug">{hint}</span>
      ) : null}
    </button>
  )
}

export function SettingsPanel({
  health,
  modelHint,
  ollamaHostReachable,
  onRefresh,
  busy,
  onBack,
  onOpenSidebar,
  models,
  selectedModel,
  onSessionsBulkDeleted,
  activeTab: tab,
  onTabChange: setTab,
}: SettingsPanelProps) {
  const oll = health?.ollama
  const ollamaOk = oll?.reachable && (oll?.model_count ?? 0) > 0

  const [researchProvider, setResearchProvider] = useState<
    'duckduckgo' | 'tavily'
  >('duckduckgo')
  const [tavilyKeyInput, setTavilyKeyInput] = useState('')
  const [tavilyStored, setTavilyStored] = useState(false)
  const [tavilyEnv, setTavilyEnv] = useState(false)
  const [prefBusy, setPrefBusy] = useState(false)
  const [prefMessage, setPrefMessage] = useState<string | null>(null)

  useEffect(() => {
    if (tab !== 'connection') return
    let live = true
    void getPreferences()
      .then((p) => {
        if (!live) return
        setResearchProvider(p.research_provider)
        setTavilyStored(p.tavily_key_stored)
        setTavilyEnv(p.tavily_key_from_env)
        setTavilyKeyInput('')
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [tab])

  async function saveResearchSettings() {
    setPrefBusy(true)
    setPrefMessage(null)
    try {
      await putPreferences({
        research_provider: researchProvider,
        ...(tavilyKeyInput.trim()
          ? { tavily_api_key: tavilyKeyInput.trim() }
          : {}),
      })
      const p = await getPreferences()
      setTavilyStored(p.tavily_key_stored)
      setTavilyEnv(p.tavily_key_from_env)
      setTavilyKeyInput('')
      setPrefMessage('Research settings saved.')
      onRefresh()
    } catch (e) {
      setPrefMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setPrefBusy(false)
    }
  }

  async function clearStoredTavilyKey() {
    setPrefBusy(true)
    setPrefMessage(null)
    try {
      await putPreferences({ tavily_api_key: '' })
      const p = await getPreferences()
      setTavilyStored(p.tavily_key_stored)
      setTavilyEnv(p.tavily_key_from_env)
      setPrefMessage('Stored Tavily key removed (env key still applies if set).')
      onRefresh()
    } catch (e) {
      setPrefMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setPrefBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#090a0d]">
      <header className="shrink-0 border-b border-white/[0.06] px-3 py-3 sm:px-4 bg-[#08090c]/90 backdrop-blur-sm">
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {onOpenSidebar && (
            <button
              type="button"
              onClick={onOpenSidebar}
              className="sm:hidden rounded-lg border border-slate-600/50 bg-slate-900/50 px-2.5 py-1.5 text-xs font-medium text-slate-200"
            >
              Chats
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-violet-300 hover:text-violet-200 font-medium"
          >
            <span aria-hidden>←</span> Back to workspace
          </button>
          <h2 className="text-base font-semibold text-slate-100 sm:ml-1">Settings</h2>
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Sidebar — desktop */}
        <nav
          className="hidden sm:flex w-56 lg:w-60 shrink-0 flex-col gap-0.5 border-r border-white/[0.06] bg-[#0b0c10]/90 p-2 overflow-y-auto"
          aria-label="Settings sections"
        >
          <NavButton
            active={tab === 'flow'}
            onClick={() => setTab('flow')}
            label="Flow"
            hint="End-to-end pipeline"
          />
          <NavButton
            active={tab === 'connection'}
            onClick={() => setTab('connection')}
            label="Connection"
            hint="Models & research"
          />
          <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            Prompts
          </div>
          <NavButton
            active={tab === 'prompts_pipeline'}
            onClick={() => setTab('prompts_pipeline')}
            label="Pipeline defaults"
            hint="Global fragments & map"
          />
          <NavButton
            active={tab === 'prompts_council'}
            onClick={() => setTab('prompts_council')}
            hint="Per-council roles"
            label="Council & roles"
          />
          <div className="px-2 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            Council
          </div>
          <NavButton
            active={tab === 'agents'}
            onClick={() => setTab('agents')}
            label="Agents"
            hint="Graph & profiles"
          />
          <NavButton
            active={tab === 'history'}
            onClick={() => setTab('history')}
            label="History"
            hint="Sessions & memory"
          />
        </nav>

        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Mobile section picker */}
          <div className="sm:hidden shrink-0 border-b border-white/[0.06] p-2 bg-[#0b0c10]/80">
            <label className="block text-[10px] text-slate-500 mb-1 px-1">Section</label>
            <select
              className="w-full rounded-lg border border-slate-600/60 bg-slate-900/90 px-2 py-2 text-sm text-slate-100"
              value={tab}
              onChange={(e) => setTab(e.target.value as SettingsTab)}
            >
              <option value="flow">Flow — how a run works</option>
              <option value="connection">Connection</option>
              <option value="prompts_pipeline">Prompts — pipeline defaults</option>
              <option value="prompts_council">Prompts — council & roles</option>
              <option value="agents">Council — agents</option>
              <option value="history">History</option>
            </select>
          </div>

          <div className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6 w-full max-w-5xl lg:max-w-none xl:max-w-6xl">
            {tab === 'flow' && <SettingsFlowOverview />}

            {tab === 'connection' && (
              <div className="max-w-xl space-y-6">
                <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Connection
                  </h3>
                  <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
                    Refresh loads models for the <span className="text-slate-300">Model</span> menu on the
                    workspace header (and for prompt refinement).
                  </p>

                  <div className="mt-4 flex items-center gap-2 text-sm text-slate-200">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        ollamaOk
                          ? 'bg-emerald-500'
                          : oll?.reachable === false
                            ? 'bg-rose-500'
                            : 'bg-amber-500'
                      }`}
                      aria-hidden
                    />
                    <span className="text-slate-400 text-xs min-w-0">
                      {!health
                        ? 'Loading…'
                        : ollamaOk
                          ? `${oll?.model_count} models · ${oll?.base_url ?? ''}`
                          : oll?.reachable
                            ? `${oll?.model_count ?? 0} models · ${oll?.base_url ?? ''}`
                            : oll?.error || 'Ollama not reachable'}
                    </span>
                    <button
                      type="button"
                      onClick={onRefresh}
                      disabled={busy}
                      className="ml-auto text-xs rounded-lg border border-slate-600/80 px-2.5 py-1.5 text-slate-200 hover:bg-white/5 disabled:opacity-40"
                    >
                      Refresh
                    </button>
                  </div>

                  {ollamaHostReachable && (
                    <p className="mt-3 text-xs text-amber-200/90 rounded-lg border border-amber-500/20 bg-amber-950/20 px-2.5 py-2">
                      No models listed. On the Ollama host run{' '}
                      <code className="text-amber-100">ollama pull &lt;name&gt;</code>, then refresh and pick a
                      model in the workspace header.
                    </p>
                  )}

                  {modelHint && (
                    <p className="mt-3 text-xs text-amber-200/95 rounded-lg border border-amber-500/25 bg-amber-950/25 px-2.5 py-2">
                      {modelHint}
                    </p>
                  )}
                </section>

                <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Web research
                  </h3>
                  <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
                    Council <span className="text-slate-300">run research</span> uses this backend. DuckDuckGo
                    needs no key.{' '}
                    <a
                      href="https://tavily.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-violet-400 hover:text-violet-300"
                    >
                      Tavily
                    </a>{' '}
                    needs an API key (or set <code className="text-slate-300">TAVILY_API_KEY</code> in{' '}
                    <code className="text-slate-300">.env</code>).
                  </p>

                  {health?.research && (
                    <p className="mt-3 text-[11px] text-slate-500">
                      Active: <span className="text-slate-300">{health.research.provider}</span>
                      {health.research.provider === 'tavily' &&
                        !health.research.tavily_ready && (
                          <span className="text-amber-200/90"> · add a key to use Tavily</span>
                        )}
                    </p>
                  )}

                  <label className="block mt-4 text-[11px] text-slate-400">
                    Search provider
                    <select
                      className="mt-1 w-full rounded-lg border border-slate-600/60 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/35"
                      value={researchProvider}
                      onChange={(e) =>
                        setResearchProvider(e.target.value as 'duckduckgo' | 'tavily')
                      }
                    >
                      <option value="duckduckgo">DuckDuckGo (no API key)</option>
                      <option value="tavily">Tavily</option>
                    </select>
                  </label>

                  <p className="mt-2 text-[11px] text-slate-500">
                    Key status:{' '}
                    {tavilyStored ? (
                      <span className="text-emerald-200/90">stored in app data</span>
                    ) : (
                      <span>not stored in app</span>
                    )}
                    {tavilyEnv ? (
                      <span className="text-slate-400"> · env variable set</span>
                    ) : null}
                  </p>

                  <label className="block mt-3 text-[11px] text-slate-400">
                    Tavily API key (saved locally on this machine)
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="tvly-…"
                      value={tavilyKeyInput}
                      onChange={(e) => setTavilyKeyInput(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-600/60 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500/35"
                    />
                  </label>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={prefBusy}
                      onClick={() => void saveResearchSettings()}
                      className="text-xs rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-2 text-white disabled:opacity-40"
                    >
                      {prefBusy ? 'Saving…' : 'Save research settings'}
                    </button>
                    {tavilyStored ? (
                      <button
                        type="button"
                        disabled={prefBusy}
                        onClick={() => void clearStoredTavilyKey()}
                        className="text-xs rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-slate-200 hover:bg-white/[0.07] disabled:opacity-40"
                      >
                        Remove stored key
                      </button>
                    ) : null}
                  </div>

                  {prefMessage && (
                    <p className="mt-3 text-xs text-slate-400">{prefMessage}</p>
                  )}
                </section>
              </div>
            )}

            {tab === 'history' && (
              <HistoryMemoryTab onBulkDeleted={onSessionsBulkDeleted} />
            )}

            {tab === 'prompts_pipeline' && (
              <AgentsTab
                mode="prompts_pipeline"
                refineModels={models}
                refineModel={selectedModel}
              />
            )}
            {tab === 'prompts_council' && (
              <AgentsTab
                mode="prompts_council"
                refineModels={models}
                refineModel={selectedModel}
              />
            )}
            {tab === 'agents' && (
              <AgentsTab mode="agents" refineModels={models} refineModel={selectedModel} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
