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

type SettingsTab = 'connection' | 'prompts' | 'agents'

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
  const councilSettingsTab = tab === 'prompts' ? 'prompts' : 'agents'
  const oll = health?.ollama
  const ollamaOk = oll?.reachable && (oll.model_count ?? 0) > 0

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#090a0d]">
      <header className="shrink-0 border-b border-white/[0.06] px-3 py-3 sm:px-4 bg-[#08090c]/80 backdrop-blur-sm">
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
            <span aria-hidden>←</span> Chats
          </button>
          <h2 className="text-base font-semibold text-slate-100">Settings</h2>
        </div>
        <div
          className="mt-4 flex flex-col sm:flex-row gap-1 p-1 rounded-xl bg-slate-900/60 border border-white/[0.06] w-full max-w-2xl"
          role="tablist"
          aria-label="Settings section"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'connection'}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'connection'
                ? 'bg-violet-500/20 text-violet-50 shadow-sm'
                : 'text-slate-500 hover:text-slate-300'
            }`}
            onClick={() => setTab('connection')}
          >
            Connection
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'prompts'}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'prompts'
                ? 'bg-violet-500/20 text-violet-50 shadow-sm'
                : 'text-slate-500 hover:text-slate-300'
            }`}
            onClick={() => setTab('prompts')}
          >
            Prompts
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agents'}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'agents'
                ? 'bg-violet-500/20 text-violet-50 shadow-sm'
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
          tab === 'connection' ? 'max-w-md' : 'max-w-6xl'
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

        {tab !== 'connection' && (
          <AgentsTab mode={councilSettingsTab} />
        )}
      </div>
    </div>
  )
}
