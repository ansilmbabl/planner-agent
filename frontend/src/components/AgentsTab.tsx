import { useCallback, useEffect, useState } from 'react'
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

export function AgentsTab() {
  const [config, setConfig] = useState<CouncilConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

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

  return (
    <div className="space-y-6 pb-8">
      <p className="text-sm text-slate-400 leading-relaxed">
        These prompts are sent to <span className="text-slate-300">config/council.json</span> on
        the API server. The next council run uses them. Keep each voice distinct; ids are fixed
        for history.
      </p>

      {config.debating_agents.map((ag, i) => (
        <section
          key={ag.id}
          className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5 space-y-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-100">
              Debating agent · {ag.name || ag.id}
            </h3>
            <code className="text-[10px] text-slate-500 font-mono">{ag.id}</code>
          </div>
          <label className="block text-xs text-slate-500">
            Display name
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-1.5 text-sm text-slate-100"
              value={ag.name}
              onChange={(e) => updateDebater(i, { name: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-500">
            Subtitle / focus
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-1.5 text-sm text-slate-100"
              value={ag.title}
              onChange={(e) => updateDebater(i, { title: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-500">
            System prompt
            <textarea
              className="mt-1 w-full min-h-[8rem] rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono leading-relaxed"
              value={ag.system_prompt}
              onChange={(e) => updateDebater(i, { system_prompt: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-slate-600 bg-slate-900"
              checked={ag.tools_enabled}
              onChange={(e) => updateDebater(i, { tools_enabled: e.target.checked })}
            />
            Tools enabled (web search / tools when the pipeline supports them)
          </label>
        </section>
      ))}

      {config.synthesizer && (
        <section className="rounded-2xl border border-violet-500/20 bg-violet-950/15 p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-violet-200">Synthesizer</h3>
            <code className="text-[10px] text-slate-500 font-mono">
              {config.synthesizer.id}
            </code>
          </div>
          <label className="block text-xs text-slate-500">
            Display name
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-1.5 text-sm text-slate-100"
              value={config.synthesizer.name}
              onChange={(e) => updateSynth({ name: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-500">
            Subtitle
            <input
              type="text"
              className="mt-1 w-full rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-1.5 text-sm text-slate-100"
              value={config.synthesizer.title}
              onChange={(e) => updateSynth({ title: e.target.value })}
            />
          </label>
          <label className="block text-xs text-slate-500">
            System prompt
            <textarea
              className="mt-1 w-full min-h-[6rem] rounded-lg border border-slate-600/70 bg-slate-950/80 px-2.5 py-2 text-sm text-slate-100 font-mono leading-relaxed"
              value={config.synthesizer.system_prompt}
              onChange={(e) => updateSynth({ system_prompt: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-slate-600 bg-slate-900"
              checked={config.synthesizer.tools_enabled}
              onChange={(e) => updateSynth({ tools_enabled: e.target.checked })}
            />
            Tools enabled
          </label>
        </section>
      )}

      {saveError && (
        <p className="text-sm text-amber-200/95 border border-amber-500/30 rounded-lg px-3 py-2">
          {saveError}
        </p>
      )}
      {saved && (
        <p className="text-sm text-emerald-300/90">Saved. New chats will use this council.</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
        >
          {saving ? 'Saving…' : 'Save agents'}
        </button>
      </div>
    </div>
  )
}
