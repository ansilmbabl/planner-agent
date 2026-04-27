export function SettingsFlowOverview() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">How a run works</h3>
        <p className="text-sm text-slate-400 mt-2 leading-relaxed">
          You chat on the left; the <span className="text-slate-200">council</span> is a scripted pipeline behind
          the scenes. The <span className="text-slate-200">orchestrator</span> decides each step; specialists only
          run when it picks them. The <span className="text-slate-200">Plan</span> panel shows{' '}
          <code className="text-slate-500">plan.md</code> when the run reaches planning.
        </p>
      </div>

      <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-b from-slate-900/50 to-slate-950/80 p-4 sm:p-5">
        <div className="flex flex-col gap-3">
          {[
            { n: '1', t: 'Message', d: 'Your idea lands in the session; optional web research if the orchestrator chooses it.' },
            { n: '2', t: 'Orchestrator loop', d: 'Each step: model reads transcript + research + roster → JSON action (call agents, ask you, synthesizer, ready for plan…).' },
            { n: '3', t: 'Specialists', d: 'Parallel JSON “turns” (reaction, planner note, optional question). Order is orchestrator-driven, not a fixed round-robin.' },
            { n: '4', t: 'Synthesizer (optional)', d: 'One alignment pass before planning if configured and called.' },
            { n: '5', t: 'Plan writer', d: 'Builds structured plan JSON → rendered as plan.md. Separate from live chat wording.' },
            { n: '6', t: 'Plan refine', d: 'Optional: Plan tab asks an LLM to edit plan.md using persona prompts + your instruction.' },
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
