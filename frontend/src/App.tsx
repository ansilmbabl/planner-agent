import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createSession,
  getHealth,
  getModels,
  type HealthResponse,
  type SseEvent,
  streamUserMessage,
} from './api'

type FeedItem = {
  id: string
  kind: 'phase' | 'research' | 'agent' | 'synth' | 'await' | 'err' | 'text'
  title: string
  body?: string
}

function simpleId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function eventLabel(ev: SseEvent): { title: string; body: string; kind: FeedItem['kind'] } {
  if (!ev || typeof ev !== 'object' || !('type' in ev)) {
    return { title: 'Event', body: JSON.stringify(ev), kind: 'text' }
  }
  const t = (ev as { type: string }).type
  if (t === 'phase') {
    const e = ev as { phase: string; message?: string; round?: number }
    return {
      kind: 'phase',
      title: e.message || e.phase || 'Phase',
      body:
        e.round != null
          ? `Round ${e.round} · ${e.phase}`
          : (e.phase ?? ''),
    }
  }
  if (t === 'research') {
    const e = ev as { brief: string }
    return { kind: 'research', title: 'Research brief', body: e.brief }
  }
  if (t === 'agent') {
    const e = ev as {
      name: string
      round: number
      reaction: string
      planner_note: string
      user_question?: string | null
    }
    let body = e.reaction
    if (e.planner_note) body += `\n\nNotes for plan:\n${e.planner_note}`
    if (e.user_question) body += `\n\nQuestion: ${e.user_question}`
    return { kind: 'agent', title: `Round ${e.round} · ${e.name}`, body }
  }
  if (t === 'awaiting_user') {
    const e = ev as { questions: string[] }
    return {
      kind: 'await',
      title: 'Your input needed',
      body: e.questions.map((q) => `• ${q}`).join('\n'),
    }
  }
  if (t === 'synth') {
    const e = ev as { summary: string }
    return { kind: 'synth', title: 'Synthesizer', body: e.summary }
  }
  if (t === 'error') {
    const e = ev as { message: string }
    return { kind: 'err', title: 'Error', body: e.message }
  }
  if (t === 'plan') {
    return {
      kind: 'text',
      title: 'Plan document ready',
      body: 'See the right panel to preview and download plan.md',
    }
  }
  if (t === 'stream_end') {
    return { kind: 'phase', title: '', body: '' }
  }
  if (t === 'done') {
    return {
      kind: 'phase',
      title: 'Complete',
      body: 'You can send another message to start a new plan (session resets).',
    }
  }
  return { kind: 'text', title: t, body: JSON.stringify(ev) }
}

export default function App() {
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('llama3.2')
  const [model, setModel] = useState('llama3.2')
  const [modelHint, setModelHint] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [phase, setPhase] = useState<string>('')
  const [awaiting, setAwaiting] = useState(false)
  const [planMd, setPlanMd] = useState('')
  const [planName, setPlanName] = useState('plan.md')
  const [research, setResearch] = useState<{
    brief: string
    sources: { title: string; href: string }[]
  } | null>(null)

  const streamAbort = useRef<AbortController | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    composerRef.current?.focus()
  }, [])

  const refreshConnection = useCallback(async () => {
    setModelHint(null)
    try {
      const h = await getHealth()
      setHealth(h)
    } catch {
      setHealth(null)
    }
    try {
      const m = await getModels()
      if (m.models.length) {
        setModels(m.models)
        const def = m.default ?? m.models[0]!
        setDefaultModel(def)
        setModel((prev) => (m.models!.includes(prev) ? prev : def))
      } else {
        let h =
          m.hint ??
          'No models in Ollama. On the host, run: ollama pull llama3.2, then click Refresh below.'
        const om = m.ollama
        if (om && typeof om === 'object' && 'error' in om && om.error) {
          h = `${h} (${om.error as string})`
        }
        setModelHint(h)
      }
    } catch {
      setModelHint('Could not load models. Is the API running?')
    }
  }, [])

  useEffect(() => {
    void refreshConnection()
  }, [refreshConnection])

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    const s = await createSession(model)
    setSessionId(s.id)
    return s.id
  }, [sessionId, model])

  const pushFeed = (ev: SseEvent) => {
    if (!ev || typeof ev !== 'object' || !('type' in ev)) return
    if ((ev as { type: string }).type === 'plan') {
      const p = ev as { content: string; filename: string }
      setPlanMd(p.content)
      setPlanName(p.filename || 'plan.md')
    }
    if ((ev as { type: string }).type === 'research') {
      const r = ev as { brief: string; sources: { title: string; href: string }[] }
      setResearch({ brief: r.brief, sources: r.sources || [] })
    }
    if ((ev as { type: string }).type === 'awaiting_user') {
      setAwaiting(true)
    } else if ((ev as { type: string }).type === 'done') {
      setAwaiting(false)
    }
    if ((ev as { type: string }).type === 'phase') {
      setPhase((ev as { phase: string }).phase)
    }
    const mapped = eventLabel(ev)
    if ((mapped.title || mapped.body) && (ev as { type?: string }).type !== 'stream_end') {
      setFeed((f) => [
        ...f,
        {
          id: simpleId(),
          kind: mapped.kind,
          title: mapped.title,
          body: mapped.body,
        },
      ])
    }
  }

  const stopStream = useCallback(() => {
    streamAbort.current?.abort()
    streamAbort.current = null
    setBusy(false)
  }, [])

  async function onSend() {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setInput('')
    const ac = new AbortController()
    streamAbort.current = ac
    try {
      const sid = await ensureSession()
      setFeed((f) => [
        ...f,
        { id: simpleId(), kind: 'text', title: 'You', body: text },
      ])
      for await (const ev of streamUserMessage(sid, text, model, ac.signal)) {
        if ((ev as { type?: string }).type === 'error') {
          setFeed((f) => [
            ...f,
            {
              id: simpleId(),
              kind: 'err',
              title: 'Error',
              body: (ev as { message: string }).message,
            },
          ])
          break
        }
        pushFeed(ev)
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        setFeed((f) => [
          ...f,
          { id: simpleId(), kind: 'err', title: 'Stopped', body: 'Request cancelled.' },
        ])
      } else {
        setFeed((f) => [
          ...f,
          {
            id: simpleId(),
            kind: 'err',
            title: 'Request',
            body: e instanceof Error ? e.message : String(e),
          },
        ])
      }
    } finally {
      streamAbort.current = null
      setBusy(false)
    }
  }

  const downloadPlan = () => {
    if (!planMd) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(
      new Blob([planMd], { type: 'text/markdown;charset=utf-8' })
    )
    a.download = planName
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const oll = health?.ollama
  const ollamaOk = oll?.reachable && (oll.model_count ?? 0) > 0
  const ollamaHostReachable = oll?.reachable === true && oll.model_count === 0

  return (
    <div className="min-h-dvh flex flex-col max-w-6xl mx-auto px-4 sm:px-6 py-6 gap-4">
      {/* Connection strip */}
      <div
        className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${
          ollamaOk
            ? 'border-emerald-500/30 bg-emerald-950/25 text-emerald-100/90'
            : oll?.reachable === false
              ? 'border-rose-500/40 bg-rose-950/30 text-rose-100/90'
              : 'border-amber-500/30 bg-amber-950/20 text-amber-100/80'
        }`}
      >
        <span className="font-medium">
          {health?.llm_provider === 'ollama' ? 'Ollama' : 'LLM'}
        </span>
        {oll && (
          <>
            <span className="text-white/50">|</span>
            <span>
              {ollamaOk
                ? `${oll.model_count} model(s) at ${oll.base_url}`
                : oll.reachable
                  ? `Connected but no models — run: ollama pull llama3.2 (on the Ollama host)`
                  : oll.error || 'Unreachable'}
            </span>
          </>
        )}
        {!oll && <span>Checking…</span>}
        <button
          type="button"
          onClick={() => void refreshConnection()}
          className="ml-auto text-xs font-medium text-white/80 hover:text-white underline-offset-2 hover:underline"
        >
          Refresh connection
        </button>
      </div>

      {ollamaHostReachable && (
        <p className="text-amber-200/90 text-sm rounded-xl border border-amber-500/30 bg-amber-950/20 px-3 py-2">
          Ollama is reachable but the model list is empty. Pull a model on the
          same machine that runs Ollama: <code className="text-amber-100">ollama pull llama3.2</code> then
          set <b>Model</b> to match, or set <code className="text-amber-100">OLLAMA_MODEL</code> in Docker.
        </p>
      )}

      <header className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 border-b border-slate-700/60 pb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
            Planner Council
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl leading-relaxed">
            Describe a product or problem. Agents debate, may ask for clarification,
            then produce a structured <code className="text-violet-300">plan.md</code>.
            <span className="text-slate-500"> Enter sends · Shift+Enter for a new line.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1.5 text-xs text-slate-500 font-medium">
            Model
            <select
              className="bg-slate-900/90 border border-slate-600 rounded-xl px-3 py-2.5 text-sm text-slate-100 min-w-[14rem] focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
            >
              {models.length === 0 && (
                <option value={defaultModel}>
                  {defaultModel} (choose after ollama pull)
                </option>
              )}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {modelHint && (
        <p className="text-amber-200/90 text-sm rounded-xl border border-amber-500/30 bg-amber-950/20 px-3 py-2">
          {modelHint}
        </p>
      )}

      <div className="grid lg:grid-cols-5 gap-5 flex-1 min-h-0 grow">
        <div className="lg:col-span-3 flex flex-col gap-3 min-h-[360px]">
          <div className="flex items-center justify-between text-xs text-slate-500 uppercase tracking-wide">
            <span>Conversation</span>
            {phase && (
              <span className="text-violet-300/90 normal-case font-medium">
                {phase}
              </span>
            )}
          </div>
          <div
            role="log"
            aria-live="polite"
            className="flex-1 rounded-2xl border border-slate-700/50 bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto max-h-[min(58vh,480px)] space-y-3 text-sm shadow-inner"
          >
            {feed.length === 0 && (
              <p className="text-slate-500 text-sm leading-relaxed">
                What do you want to build? Mention constraints, stack, and what
                &quot;done&quot; means.
              </p>
            )}
            {feed.map((f) => (
              <article
                key={f.id}
                className={`rounded-xl px-3 py-2.5 border ${
                  f.kind === 'err'
                    ? 'border-rose-500/35 bg-rose-950/25'
                    : f.title === 'You'
                      ? 'border-violet-500/25 bg-violet-950/20'
                      : 'border-slate-600/40 bg-slate-800/40'
                }`}
              >
                <div className="text-xs text-violet-200/80 font-semibold">
                  {f.title}
                </div>
                {f.body && (
                  <p className="text-slate-200/95 mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                    {f.body}
                  </p>
                )}
              </article>
            ))}
            {busy && (
              <p className="text-slate-500 text-sm flex items-center gap-2">
                <span className="inline-block size-2 rounded-full bg-violet-500 animate-pulse" />
                Working…
              </p>
            )}
          </div>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
            <textarea
              ref={composerRef}
              id="message-input"
              name="message"
              autoComplete="off"
              className="flex-1 min-h-[100px] rounded-xl border border-slate-600/90 bg-slate-950/60 px-3 py-2.5 text-slate-100 placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
              placeholder={
                awaiting
                  ? 'Answer the questions above, or say to proceed with your best assumptions…'
                  : 'Type your idea… (Enter to send, Shift+Enter for newline)'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!busy) void onSend()
                }
              }}
              disabled={busy}
            />
            <div className="flex sm:flex-col gap-2">
              <button
                type="button"
                onClick={() => void onSend()}
                disabled={busy || !input.trim()}
                className="rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:pointer-events-none px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-violet-900/20"
              >
                Send
              </button>
              {busy && (
                <button
                  type="button"
                  onClick={stopStream}
                  className="rounded-xl border border-slate-500/60 bg-slate-800/80 px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700/80"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 flex flex-col gap-3 min-h-0">
          <div className="text-xs text-slate-500 uppercase tracking-wide">
            Research & plan
          </div>
          <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-4 flex flex-col gap-3 flex-1 min-h-0 max-h-[min(72vh,640px)] shadow-lg shadow-black/20">
            {research && (
              <div className="shrink-0">
                <h3 className="text-sm font-medium text-slate-200">Sources</h3>
                <ul className="mt-2 text-xs text-slate-500 space-y-1.5 max-h-24 overflow-y-auto">
                  {research.sources.slice(0, 10).map((s) => (
                    <li key={s.href}>
                      <a
                        href={s.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-violet-400 hover:text-violet-300 hover:underline line-clamp-2"
                      >
                        {s.title || s.href}
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-slate-400 mt-2 leading-relaxed line-clamp-4">
                  {research.brief}
                </p>
              </div>
            )}
            <div className="flex-1 min-h-0 flex flex-col border-t border-slate-700/50 pt-3">
              <div className="flex justify-between items-center mb-2 gap-2">
                <h3 className="text-sm font-medium text-slate-200">plan.md</h3>
                {planMd && (
                  <button
                    type="button"
                    onClick={downloadPlan}
                    className="text-xs rounded-lg border border-violet-500/35 px-2.5 py-1.5 text-violet-200 hover:bg-violet-950/50"
                  >
                    Download
                  </button>
                )}
              </div>
              {planMd ? (
                <pre className="flex-1 overflow-y-auto pr-1 text-left text-xs text-slate-300/95 font-mono leading-relaxed whitespace-pre-wrap min-h-0 max-h-80">
                  {planMd}
                </pre>
              ) : (
                <p className="text-slate-500 text-sm leading-relaxed">
                  Your implementation plan (sections, tasks, and checklist) will
                  show here. Fix Ollama connection (strip above) if nothing runs.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
