import { useState } from 'react'
import type { HealthResponse } from '../api'
import { AgentsTab } from './AgentsTab'

type SettingsPanelProps = {
  health: HealthResponse | null
  modelHint: string | null
  ollamaHostReachable: boolean
  onRefresh: () => void
  busy: boolean
  onBack: () => void
  onOpenSidebar?: () => void
}

type SettingsTab = 'connection' | 'agents'

export function SettingsPanel({
  health,
  modelHint,
  ollamaHostReachable,
  onRefresh,
  busy,
  onBack,
  onOpenSidebar,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>('connection')
  const oll = health?.ollama
  const ollamaOk = oll?.reachable && (oll.model_count ?? 0) > 0

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0b0c0f]">
      <header className="shrink-0 border-b border-white/5 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-3 flex-wrap">
          {onOpenSidebar && (
            <button
              type="button"
              onClick={onOpenSidebar}
              className="sm:hidden rounded-lg border border-slate-600/60 px-2.5 py-1.5 text-xs text-slate-200"
            >
              Chats
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-violet-400 hover:underline"
          >
            ← Back to chats
          </button>
          <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
        </div>
        <div
          className="mt-3 flex gap-1 p-0.5 rounded-xl bg-slate-900/80 border border-white/5 w-fit"
          role="tablist"
          aria-label="Settings section"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'connection'}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === 'connection'
                ? 'bg-violet-500/25 text-violet-100'
                : 'text-slate-500 hover:text-slate-300'
            }`}
            onClick={() => setTab('connection')}
          >
            Connection
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agents'}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              tab === 'agents'
                ? 'bg-violet-500/25 text-violet-100'
                : 'text-slate-500 hover:text-slate-300'
            }`}
            onClick={() => setTab('agents')}
          >
            Council agents
          </button>
        </div>
      </header>

      <div
        className={`flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6 w-full mx-auto ${
          tab === 'agents' ? 'max-w-6xl' : 'max-w-md'
        }`}
      >
        {tab === 'connection' && (
          <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Connection
            </h3>
            <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
              Refresh loads models for the <span className="text-slate-300">Model</span> menu on
              the main screen. You can add more options here later.
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
                <code className="text-amber-100">ollama pull &lt;name&gt;</code>, then
                refresh and pick a model in the main header.
              </p>
            )}

            {modelHint && (
              <p className="mt-3 text-xs text-amber-200/95 rounded-lg border border-amber-500/25 bg-amber-950/25 px-2.5 py-2">
                {modelHint}
              </p>
            )}
          </section>
        )}

        {tab === 'agents' && <AgentsTab />}
      </div>
    </div>
  )
}
