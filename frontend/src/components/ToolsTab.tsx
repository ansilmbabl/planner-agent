import { useEffect, useState } from 'react'
import { getTools, type AgentToolDefinition } from '../api'

export function ToolsTab() {
  const [tools, setTools] = useState<AgentToolDefinition[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void getTools()
      .then((t) => {
        if (live) {
          setTools(t)
          setError(null)
        }
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="max-w-2xl space-y-6">
      <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tools</h3>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">
          Registered capabilities for <span className="text-slate-200">council agents</span> are listed below. Each
          agent can allow <span className="text-slate-200">all</span> of them (default — empty{' '}
          <code className="text-slate-500">tool_ids</code> in council JSON) or an explicit subset. Stable{' '}
          <code className="text-slate-500">id</code> values are what you store in JSON; the server adds new tools here
          as the product grows.
        </p>
        <p className="text-sm text-slate-400 mt-3 leading-relaxed">
          This is separate from the orchestrator’s <code className="text-slate-500">run_research</code> step, which
          runs web search for the session and feeds the shared research brief. Per-agent tools mainly shape the
          specialist <span className="text-slate-200">system prompt</span> (what the model should assume it may rely
          on).
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Registry</h3>
        {error ? (
          <p className="mt-3 text-sm text-rose-200/90">{error}</p>
        ) : tools.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {tools.map((t) => (
              <li
                key={t.id}
                className="rounded-xl border border-white/[0.06] bg-slate-950/40 px-3 py-3 sm:px-4"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium text-slate-100">{t.name}</span>
                  <code className="text-[11px] text-violet-300/90">{t.id}</code>
                </div>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">{t.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
