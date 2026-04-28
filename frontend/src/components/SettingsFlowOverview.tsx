export function SettingsFlowOverview() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">How a run works</h3>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">
          You chat on the left; the <span className="text-slate-200">council</span> is driven behind the scenes by
          the <span className="text-slate-200">orchestrator</span> persona you configure. It chooses each step;
          <span className="text-slate-200"> agents</span> you add to the roster only run when it routes to them
          (for example via <code className="text-slate-500">call_agents</code>). The{' '}
          <span className="text-slate-200">Output</span> panel holds the primary deliverable for the run — plan,
          report, code, none, or chat-only. In the main window, open Outputs → Research to add URLs; they merge into
          the same research brief as web search.
        </p>
      </div>

      <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-b from-slate-900/50 to-slate-950/80 p-4 sm:p-5">
        <div className="flex flex-col gap-3">
          {[
            {
              n: '1',
              t: 'Message',
              d: 'Your idea lands in the session; optional web research if the orchestrator chooses it.',
            },
            {
              n: '2',
              t: 'Orchestrator loop',
              d: 'Each step: model reads transcript + research + roster → one JSON action (call agents, ask you, primary output, end, …).',
            },
            {
              n: '3',
              t: 'Agents',
              d: 'Structured JSON “turns” per specialist id the orchestrator picked. Parallel batch, order, and repeats are all routing decisions — not a fixed pipeline.',
            },
            {
              n: '4',
              t: 'Primary output',
              d: 'Depending on council settings: structured plan, markdown report, code file, or no file (conversation-only).',
            },
            {
              n: '5',
              t: 'Refine output',
              d: 'Optional: Output tab — LLM edit of the latest file using merged persona prompts + your instruction.',
            },
          ].map((row) => (
            <div
              key={row.n}
              className="flex gap-3 items-start rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2.5"
            >
              <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/20 text-xs font-semibold text-violet-200">
                {row.n}
              </span>
              <div>
                <div className="text-sm font-medium text-slate-200">{row.t}</div>
                <p className="text-[12px] text-slate-500 mt-0.5 leading-relaxed">{row.d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-3 text-[12px] text-slate-500 leading-relaxed">
        <span className="text-slate-400">In the thread</span>, use <span className="text-slate-300">Focus</span> for
        chat-only, or <span className="text-slate-300">All</span> to see routing and research lines. Those lines use
        the same agent <span className="text-slate-400">routing ids</span> you set under{' '}
        <span className="text-slate-400">Council agents</span>.
      </div>
    </div>
  )
}
