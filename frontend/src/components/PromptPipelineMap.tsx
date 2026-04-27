/**
 * Static map of how built-in pipeline prompts compose into real LLM calls.
 * Helps users editing data/prompt_overrides.json understand structure.
 */
export function PromptPipelineMap() {
  return (
    <div className="rounded-2xl border border-slate-600/35 bg-slate-950/40 p-4 sm:p-5 space-y-5 max-w-5xl">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">How pipeline prompts connect</h3>
        <p className="text-[11px] text-slate-500 mt-1 leading-relaxed max-w-3xl">
          These keys live in <code className="text-slate-600">data/prompt_overrides.json</code>. They are{' '}
          <span className="text-slate-400">fragments</span> the backend concatenates with live session text — not
          one giant prompt file.
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="text-[10px] uppercase tracking-widest text-slate-500">End-to-end run</h4>
        <ol className="space-y-2 text-[12px] text-slate-400 leading-relaxed list-decimal pl-4 marker:text-slate-600">
          <li>
            <span className="text-slate-200">You send a message</span> → session stores the idea and transcript.
          </li>
          <li>
            <span className="text-slate-200">Orchestrator (many turns)</span> chooses{' '}
            <code className="text-slate-500">run_research</code>, <code className="text-slate-500">call_agents</code>,{' '}
            <code className="text-slate-500">call_synthesizer</code>, etc.
          </li>
          <li>
            <span className="text-slate-200">Research</span> (if chosen): planner → web → summarizer brief.
          </li>
          <li>
            <span className="text-slate-200">Specialists</span> (if chosen): each gets a structured JSON turn.
          </li>
          <li>
            <span className="text-slate-200">Synthesizer</span> (optional): alignment summary from council JSON.
          </li>
          <li>
            <span className="text-slate-200">Plan writer</span> → <code className="text-slate-500">plan.md</code>.
          </li>
          <li>
            <span className="text-slate-200">Plan refine</span> (later, Plan tab): personas + markdown plan + your instruction.
          </li>
        </ol>
      </div>

      <div className="grid gap-3 sm:grid-cols-1">
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-950/15 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-cyan-200/90">Orchestrator routing (per step)</div>
          <pre className="text-[10px] text-slate-500 font-mono leading-relaxed whitespace-pre-wrap">
{`SYSTEM  = council.orchestrator.system_prompt
         + pipeline["orchestrator_json_suffix"]

USER    = template(user idea, research brief, transcript summary, roster, step…)
         + council.orchestrator_user_instructions  (routing guidelines)
         + pipeline["orchestrator_decision_schema"]  (JSON action schema)`}
          </pre>
          <p className="text-[10px] text-slate-500">
            Council fields are edited under <span className="text-slate-400">Council &amp; roles</span>. Pipeline
            suffix + schema are under <span className="text-slate-400">Pipeline defaults</span>.
          </p>
        </div>

        <div className="rounded-xl border border-violet-500/20 bg-violet-950/15 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-violet-200/90">Specialist turn (each agent)</div>
          <pre className="text-[10px] text-slate-500 font-mono leading-relaxed whitespace-pre-wrap">
{`SYSTEM  = council.debater.system_prompt
         + pipeline["debate_turn_schema"]

USER    = template(round, prior rounds, research, same-round context…)
         + pipeline["debate_turn_schema"]  (repeated in user block for shape)`}
          </pre>
        </div>

        <div className="rounded-xl border border-amber-500/20 bg-amber-950/15 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-amber-200/90">Plan writer (after debate)</div>
          <pre className="text-[10px] text-slate-500 font-mono leading-relaxed whitespace-pre-wrap">
{`SYSTEM  = pipeline["plan_writer_system"]

USER    = pipeline["plan_json_schema_hint"]
         + user idea, prior plan, research, synthesizer summary, transcript excerpt
         + pipeline["plan_writer_user_footer"]`}
          </pre>
        </div>

        <div className="rounded-xl border border-slate-600/40 bg-slate-900/30 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-slate-200/90">Research</div>
          <pre className="text-[10px] text-slate-500 font-mono leading-relaxed whitespace-pre-wrap">
{`Planner   SYSTEM + idea + pipeline["research_planner_user_suffix"]
Summarize SYSTEM + results + pipeline["research_summarizer_user_closing"]`}
          </pre>
        </div>

        <div className="rounded-xl border border-slate-600/40 bg-slate-900/30 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-slate-200/90">Refine plan (Plan tab)</div>
          <pre className="text-[10px] text-slate-500 font-mono leading-relaxed whitespace-pre-wrap">
{`SYSTEM  = joined persona system prompts (orchestrator / debaters / synth)
USER    = full plan.md + instruction + pipeline["plan_refine_user_suffix"]`}
          </pre>
        </div>
      </div>
    </div>
  )
}
