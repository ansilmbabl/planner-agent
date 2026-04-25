import { useCallback, useEffect, useState } from 'react'
import {
  createSession,
  getModels,
  type SseEvent,
  streamUserMessage,
} from './api'

type FeedItem = {
  id: string
  kind: 'phase' | 'research' | 'agent' | 'synth' | 'await' | 'err' | 'text'
  title: string
  body?: string
  meta?: string
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
      title: e.message ?? e.phase,
      body: e.round != null ? `Round: ${e.round} · ${e.phase}` : e.phase,
    }
  }
  if (t === 'research') {
    const e = ev as { brief: string; sources: { href: string; title: string }[] }
    return {
      kind: 'research',
      title: 'Research brief',
      body: e.brief,
      ...{},
    } as { title: string; body: string; kind: FeedItem['kind'] }
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
    if (e.planner_note) body += `\n\n_Notes for plan:_\n${e.planner_note}`
    if (e.user_question) body += `\n\n_Question to user:_ ${e.user_question}`
    return { kind: 'agent', title: `R${e.round} · ${e.name}`, body }
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
      body: 'See the panel on the right — you can download plan.md.',
    }
  }
  if (t === 'stream_end') {
    return { kind: 'phase', title: '', body: '' }
  }
  if (t === 'done') {
    return { kind: 'phase', title: 'Complete', body: 'You can start a new idea by sending another message after the plan (session resets on next send).' }
  }
  return { kind: 'text', title: t, body: JSON.stringify(ev) }
}


export default function App() {
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('llama3.2')
  const [model, setModel] = useState('llama3.2')
  const [modelHint, setModelHint] = useState<string | null>(null)
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

  const refreshModels = useCallback(async () => {
    try {
      const m = await getModels()
      if (m.models.length) {
        setModels(m.models)
        setDefaultModel(m.default ?? m.models[0]!)
        setModel(m.default ?? m.models[0]!)
      } else {
        setModelHint(
          (m as { hint?: string }).hint ??
            'No models found — set Ollama and pull a model, or set LLM provider in .env'
        )
      }
    } catch {
      setModelHint('Could not list models. Is the API up?')
    }
  }, [])

  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

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
      setResearch({ brief: r.brief, sources: r.sources })
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

  const onSend = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setInput('')
    try {
      const sid = await ensureSession()
      setFeed((f) => [
        ...f,
        {
          id: simpleId(),
          kind: 'text',
          title: 'You',
          body: text,
        },
      ])
      for await (const ev of streamUserMessage(sid, text, model)) {
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
      setFeed((f) => [
        ...f,
        {
          id: simpleId(),
          kind: 'err',
          title: 'Request',
          body: e instanceof Error ? e.message : String(e),
        },
      ])
    } finally {
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

  return (
    <div className="min-h-dvh flex flex-col max-w-6xl mx-auto px-4 py-6 gap-6">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-slate-700/60 pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-white">
            Planner Council
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-xl">
            Describe a product or problem. A council of agents discusses it,
            optionally asks you for clarification, then produces a{' '}
            <code className="text-violet-300">plan.md</code> for agentic
            implementers.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Model
            <select
              className="bg-slate-900/80 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 min-w-[12rem]"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
            >
              {models.length === 0 && (
                <option value={defaultModel}>{defaultModel} (type if custom)</option>
              )}
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void refreshModels()}
            className="text-xs text-violet-400 hover:underline h-8"
          >
            Refresh models
          </button>
        </div>
      </header>

      {modelHint && (
        <p className="text-amber-200/90 text-sm bg-amber-900/20 border border-amber-800/50 rounded-lg px-3 py-2">
          {modelHint}
        </p>
      )}

      <div className="grid lg:grid-cols-2 gap-6 flex-1 min-h-0">
        <div className="flex flex-col gap-3 min-h-[420px]">
          <div className="flex items-center justify-between text-xs text-slate-500 uppercase tracking-wide">
            <span>Chat</span>
            {phase && (
              <span className="text-violet-300 normal-case">Phase: {phase}</span>
            )}
          </div>
          <div className="flex-1 rounded-2xl border border-slate-700/60 bg-slate-900/40 p-4 overflow-y-auto max-h-[min(60vh,520px)] space-y-3 text-sm">
            {feed.length === 0 && (
              <p className="text-slate-500 text-sm">
                What do you want to build or fix? Be specific about constraints
                and success criteria.
              </p>
            )}
            {feed.map((f) => (
              <div
                key={f.id}
                className={`rounded-xl px-3 py-2 border ${
                  f.kind === 'err'
                    ? 'border-red-800/60 bg-red-950/20'
                    : f.title === 'You'
                      ? 'border-violet-500/20 bg-violet-950/20'
                      : 'border-slate-700/50 bg-slate-800/30'
                }`}
              >
                <div className="text-xs text-violet-300/80 font-medium">
                  {f.title}
                </div>
                {f.body && (
                  <p className="text-slate-200 mt-1 whitespace-pre-wrap text-sm">
                    {f.body}
                  </p>
                )}
              </div>
            ))}
            {busy && (
              <div className="text-slate-500 text-sm animate-pulse">
                Council in session…
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <textarea
              className="flex-1 min-h-[88px] rounded-xl border border-slate-600/80 bg-slate-950/50 px-3 py-2 text-slate-100 placeholder-slate-600 text-sm"
              placeholder={
                awaiting
                  ? 'Answer the questions above, or say to proceed with assumptions…'
                  : 'Describe the idea, stack preferences, and what “done” means…'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void onSend()
                }
              }}
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => void onSend()}
              disabled={busy}
              className="self-end rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-5 py-2 text-sm font-medium text-white"
            >
              Send
            </button>
          </div>
          <p className="text-xs text-slate-600">⌃⌘ Enter to send</p>
        </div>

        <div className="flex flex-col gap-3 min-h-0">
          <div className="text-xs text-slate-500 uppercase tracking-wide">
            Research & plan
          </div>
          <div className="rounded-2xl border border-slate-700/60 bg-slate-900/30 p-4 flex flex-col gap-3 flex-1 min-h-0 max-h-[min(70vh,640px)]">
            {research && (
              <div className="shrink-0">
                <h3 className="text-sm font-medium text-slate-300">Sources</h3>
                <ul className="mt-1 text-xs text-slate-500 space-y-1 max-h-20 overflow-y-auto">
                  {research.sources.slice(0, 8).map((s) => (
                    <li key={s.href}>
                      <a
                        href={s.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-violet-400 hover:underline truncate block"
                      >
                        {s.title || s.href}
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-slate-400 mt-2 line-clamp-3">
                  {research.brief}
                </p>
              </div>
            )}
            <div className="flex-1 min-h-0 flex flex-col border-t border-slate-700/50 pt-3">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-slate-300">plan.md</h3>
                {planMd && (
                  <button
                    type="button"
                    onClick={downloadPlan}
                    className="text-xs rounded-lg border border-violet-500/40 px-2 py-1 text-violet-200 hover:bg-violet-950/50"
                  >
                    Download {planName}
                  </button>
                )}
              </div>
              {planMd ? (
                <pre className="flex-1 overflow-y-auto pr-1 text-left text-xs text-slate-300 font-mono leading-relaxed whitespace-pre-wrap max-h-96">
                  {planMd}
                </pre>
              ) : (
                <p className="text-slate-500 text-sm">
                  The full structured plan will appear here when the council
                  finishes. Use Ollama for a free, local run.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
