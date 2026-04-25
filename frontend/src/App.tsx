import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import {
  createSession,
  deleteSessionApi,
  getHealth,
  getModels,
  getSession,
  listSessions,
  type HealthResponse,
  type SessionListItem,
  type SessionMessage,
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
    return { kind: 'research', title: 'Research', body: e.brief }
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
      title: 'Your input',
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
      title: 'Plan ready',
      body: 'See the document panel (right) to preview and download.',
    }
  }
  if (t === 'stream_end') {
    return { kind: 'phase', title: '', body: '' }
  }
  if (t === 'done') {
    return {
      kind: 'phase',
      title: 'Complete',
      body: 'You can add another message, or start a new chat in the sidebar.',
    }
  }
  return { kind: 'text', title: t, body: JSON.stringify(ev) }
}

function sessionMessagesToFeed(msgs: SessionMessage[]): FeedItem[] {
  if (!msgs?.length) return []
  return msgs.map((m, i) => ({
    id: `hist-${i}-${(m.content || '').slice(0, 6)}`,
    kind: 'text' as const,
    title:
      m.role === 'user'
        ? 'You'
        : (m.agent_name as string) ||
          (m.agent_id as string) ||
          (m.role === 'assistant' ? 'Assistant' : m.role),
    body: m.content,
  }))
}

function formatSessionTime(ts: number) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function phasePill(phase: string) {
  const p = (phase || 'idle').toLowerCase()
  if (p === 'done' || p === 'idle') {
    return 'text-slate-500 border-slate-600/50'
  }
  if (p === 'error') return 'text-rose-300 border-rose-500/30'
  if (p === 'awaiting_user') return 'text-amber-200 border-amber-500/30'
  return 'text-violet-200 border-violet-500/30'
}

export default function App() {
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [modelHint, setModelHint] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionList, setSessionList] = useState<SessionListItem[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [rightPanelTab, setRightPanelTab] = useState<'research' | 'plan'>('plan')
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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  const refreshConnection = useCallback(async () => {
    setModelHint(null)
    let h: Awaited<ReturnType<typeof getHealth>> | null = null
    try {
      h = await getHealth()
      setHealth(h)
    } catch {
      setHealth(null)
    }
    try {
      const m = await getModels()
      let list = Array.isArray(m.models) ? m.models : []
      const healthModels = h?.ollama?.models
      if (!list.length && Array.isArray(healthModels) && healthModels.length) {
        list = healthModels
      }
      if (list.length) {
        setModels(list)
        const def = m.default && list.includes(m.default) ? m.default : list[0]!
        setModel((prev) => (prev && list.includes(prev) ? prev : def))
      } else {
        let msg =
          m.hint ??
          'No models in Ollama. On the host, run: ollama pull <name>, then click Refresh below.'
        const om = m.ollama
        if (om && typeof om === 'object' && 'error' in om && om.error) {
          msg = `${msg} (${om.error as string})`
        }
        setModelHint(msg)
        setModels([])
      }
    } catch {
      setModelHint('Could not load models. Is the API running?')
    }
  }, [])

  const loadSessionList = useCallback(async () => {
    try {
      const list = await listSessions()
      setSessionList(list)
    } catch {
      setSessionList([])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshConnection()
    void loadSessionList()
  }, [refreshConnection, loadSessionList])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.matchMedia('(max-width: 639px)').matches) {
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const currentSessionTitle = useMemo(() => {
    if (!sessionId) return null
    return sessionList.find((s) => s.id === sessionId)?.title || null
  }, [sessionId, sessionList])

  useEffect(() => {
    scrollToBottom()
  }, [feed, busy])

  const clearWorkspace = useCallback(() => {
    setFeed([])
    setPlanMd('')
    setPlanName('plan.md')
    setResearch(null)
    setPhase('')
    setAwaiting(false)
    setRightPanelTab('plan')
  }, [])

  const stopStream = useCallback(() => {
    streamAbort.current?.abort()
    streamAbort.current = null
    setBusy(false)
  }, [])

  const hydrateFromApi = useCallback((data: Awaited<ReturnType<typeof getSession>>) => {
    if (data.model) setModel(data.model)
    setPhase(data.phase || '')
    setAwaiting((data.phase || '') === 'awaiting_user')
    setPlanMd(data.plan_markdown || '')
    setPlanName(data.plan_filename || 'plan.md')
    if (data.research_brief) {
      setResearch({
        brief: data.research_brief,
        sources: (data.research_sources || []) as { title: string; href: string }[],
      })
      setRightPanelTab('research')
    } else {
      setResearch(null)
      setRightPanelTab('plan')
    }
    setFeed(sessionMessagesToFeed(data.messages || []))
  }, [])

  const openSession = useCallback(
    async (id: string) => {
      stopStream()
      try {
        const data = await getSession(id)
        setSessionId(id)
        hydrateFromApi(data)
        setSidebarOpen(false)
        composerRef.current?.focus()
      } catch (e) {
        setModelHint(
          e instanceof Error ? e.message : 'Failed to open session'
        )
      }
    },
    [hydrateFromApi, stopStream]
  )

  const newChat = useCallback(async () => {
    if (!model.trim()) {
      setModelHint('Pick a model first.')
      return
    }
    stopStream()
    try {
      const s = await createSession(model)
      setSessionId(s.id)
      clearWorkspace()
      await loadSessionList()
      setSidebarOpen(false)
      composerRef.current?.focus()
    } catch (e) {
      setModelHint(
        e instanceof Error ? e.message : 'Could not start a new session'
      )
    }
  }, [model, clearWorkspace, loadSessionList, stopStream])

  const removeSession = useCallback(
    async (id: string, e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      if (!window.confirm('Delete this chat and its saved history?')) return
      try {
        await deleteSessionApi(id)
        if (sessionId === id) {
          setSessionId(null)
          clearWorkspace()
        }
        await loadSessionList()
      } catch (err) {
        setModelHint(
          err instanceof Error ? err.message : 'Delete failed'
        )
      }
    },
    [sessionId, clearWorkspace, loadSessionList]
  )

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    const s = await createSession(model)
    setSessionId(s.id)
    await loadSessionList()
    return s.id
  }, [sessionId, model, loadSessionList])

  const pushFeed = (ev: SseEvent) => {
    if (!ev || typeof ev !== 'object' || !('type' in ev)) return
    if ((ev as { type: string }).type === 'plan') {
      const p = ev as { content: string; filename: string }
      setPlanMd(p.content)
      setPlanName(p.filename || 'plan.md')
      if (window.matchMedia('(max-width: 1023px)').matches) {
        setRightPanelTab('plan')
      }
    }
    if ((ev as { type: string }).type === 'research') {
      const r = ev as { brief: string; sources: { title: string; href: string }[] }
      setResearch({ brief: r.brief, sources: r.sources || [] })
      if (window.matchMedia('(max-width: 1023px)').matches) {
        setRightPanelTab('research')
      }
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

  async function onSend() {
    const text = input.trim()
    if (!text || busy) return
    if (!model.trim()) {
      setModelHint('Select a model from the list.')
      return
    }
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
          { id: simpleId(), kind: 'err', title: 'Stopped', body: 'Cancelled.' },
        ])
      } else {
        setFeed((f) => [
          ...f,
          {
            id: simpleId(),
            kind: 'err',
            title: 'Error',
            body: e instanceof Error ? e.message : String(e),
          },
        ])
      }
    } finally {
      streamAbort.current = null
      setBusy(false)
      void loadSessionList()
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
    <div className="h-dvh flex flex-col sm:flex-row bg-[#0b0c0f] text-slate-100 overflow-hidden">
      {/* Mobile: dim + close when tapping outside */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close chat list"
          className="fixed inset-0 z-30 bg-black/55 backdrop-blur-[2px] sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — sessions */}
      <aside
        id="session-sidebar"
        className={`
        fixed z-40 inset-y-0 left-0 flex flex-col w-[min(100%,19rem)] border-r border-white/5
        bg-[#0e1016] shadow-2xl shadow-black/40
        transition-transform duration-200 ease-out motion-reduce:transition-none
        sm:static sm:z-0 sm:w-80 sm:max-h-none sm:shadow-none sm:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}
      `}
        aria-label="Chat history"
      >
        <div className="p-3 border-b border-white/5 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-white tracking-tight">
              Planner Council
            </h1>
            <p className="text-[11px] text-slate-500 leading-snug">
              Multi-agent plans → <span className="text-violet-300">plan.md</span>
            </p>
          </div>
        </div>
        <div className="p-2">
          <button
            type="button"
            onClick={() => void newChat()}
            className="w-full rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-[0.98] text-white text-sm font-medium py-2.5 px-3 shadow-lg shadow-violet-900/25 transition motion-reduce:transform-none"
          >
            New chat
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 space-y-0.5">
          {sessionsLoading && (
            <div className="px-2 py-2 space-y-2" aria-hidden>
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="rounded-xl border border-white/5 bg-white/[0.03] p-2.5 animate-pulse"
                >
                  <div className="h-3.5 bg-slate-700/50 rounded w-4/5 mb-2" />
                  <div className="h-2.5 bg-slate-800/80 rounded w-2/5" />
                </div>
              ))}
            </div>
          )}
          {!sessionsLoading && sessionList.length === 0 && (
            <p className="text-xs text-slate-500 px-2 py-3 leading-relaxed">
              No saved chats yet. Start one and it stays on this server so you can
              pick it up anytime.
            </p>
          )}
          {!sessionsLoading &&
            sessionList.map((s) => {
            const active = s.id === sessionId
            return (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                onClick={() => void openSession(s.id)}
                onKeyDown={(e) => e.key === 'Enter' && void openSession(s.id)}
                className={`
                  group w-full text-left rounded-xl px-2.5 py-2 pr-1 flex gap-1 items-start
                  transition-colors focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-500/50
                  ${
                    active
                      ? 'bg-violet-500/15 border border-violet-500/30 ring-1 ring-violet-500/10'
                      : 'hover:bg-white/5 border border-transparent'
                  }
                `}
              >
                <div
                  className={`shrink-0 w-0.5 self-stretch rounded-full ${active ? 'bg-violet-400' : 'bg-transparent'}`}
                  aria-hidden
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-100 line-clamp-2 font-medium">
                    {s.title || 'Untitled'}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-[10px] text-slate-500">
                    <span
                      className={`rounded px-1 py-0.5 border ${phasePill(s.phase)}`}
                    >
                      {s.phase}
                    </span>
                    {s.has_plan && (
                      <span className="text-emerald-400/90">plan</span>
                    )}
                    <span className="ml-auto tabular-nums">
                      {formatSessionTime(s.updated_ts)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 shrink-0
                    ${active ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'}`}
                  title="Delete chat"
                  aria-label={`Delete ${s.title || 'chat'}`}
                  onClick={(e) => void removeSession(s.id, e)}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-9 0v10a1 1 0 001 1h6a1 1 0 001-1V7M10 11v5M14 11v5"
                    />
                  </svg>
                </button>
              </div>
            )
          })}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top bar */}
        <header className="shrink-0 border-b border-white/5 bg-[#0b0c0f]/90 backdrop-blur-sm px-3 py-2 sm:px-4 flex flex-wrap items-center gap-2 z-10">
          <button
            type="button"
            className="sm:hidden rounded-lg border border-slate-600/60 px-2.5 py-1.5 text-xs text-slate-200 touch-manipulation"
            onClick={() => setSidebarOpen((o) => !o)}
            aria-expanded={sidebarOpen}
            aria-controls="session-sidebar"
            aria-label={sidebarOpen ? 'Close chat list' : 'Open chat list'}
          >
            {sidebarOpen ? 'Close' : 'Chats'}
          </button>
          <div
            className={`hidden sm:block h-2 w-2 rounded-full shrink-0 ${
              ollamaOk ? 'bg-emerald-500' : oll?.reachable === false ? 'bg-rose-500' : 'bg-amber-500'
            }`}
          />
          <span className="text-xs text-slate-400 hidden sm:inline">
            {ollamaOk
              ? `${oll?.model_count} models · ${oll?.base_url}`
              : oll?.error || 'Ollama status…'}
          </span>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <label className="text-[10px] uppercase text-slate-500 font-medium">
              Model
              <select
                className="ml-1.5 block mt-0.5 rounded-lg border border-slate-600/80 bg-slate-900/90 px-2 py-1.5 text-xs text-slate-100 min-w-[10rem] max-w-[14rem] focus:ring-1 focus:ring-violet-500/50"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy}
              >
                {models.length === 0 && (
                  <option value="" disabled>
                    No models
                  </option>
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
              onClick={() => {
                void refreshConnection()
                void loadSessionList()
              }}
              className="text-xs text-violet-400 hover:underline"
            >
              Refresh
            </button>
          </div>
        </header>

        {ollamaHostReachable && (
          <div className="shrink-0 mx-3 mt-2 text-amber-200/80 text-xs rounded-lg border border-amber-500/20 bg-amber-950/20 px-2 py-1.5">
            No models in Ollama — run <code className="text-amber-100">ollama pull &lt;name&gt;</code>
          </div>
        )}

        {modelHint && (
          <div className="shrink-0 mx-3 mt-2 text-amber-200/90 text-xs rounded-lg border border-amber-500/25 bg-amber-950/20 px-2 py-1.5">
            {modelHint}
            <button
              type="button"
              className="ml-2 text-amber-100 underline"
              onClick={() => setModelHint(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 border-b lg:border-b-0 lg:border-r border-white/5">
            <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 text-[10px] text-slate-500 uppercase tracking-wide border-b border-white/5">
              <div className="min-w-0 flex-1">
                <div className="text-[9px] font-medium text-slate-500">Chat</div>
                {sessionId && (
                  <div className="mt-0.5 normal-case text-xs text-slate-200/90 font-medium line-clamp-1 tracking-normal">
                    {currentSessionTitle || 'New session'}
                  </div>
                )}
              </div>
              {sessionId && (
                <span
                  className="text-slate-600 font-mono text-[9px] truncate max-w-[5rem] sm:max-w-[10rem] shrink-0"
                  title={sessionId}
                >
                  {sessionId}
                </span>
              )}
              {phase && (
                <span
                  className="text-violet-300/90 normal-case text-[9px] max-w-[7rem] truncate"
                  title={phase}
                >
                  {phase}
                </span>
              )}
            </div>
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 py-3 space-y-3"
            >
              {feed.length === 0 && !sessionId && (
                <div className="rounded-2xl border border-dashed border-slate-600/35 bg-gradient-to-b from-slate-900/40 to-slate-950/30 p-6 sm:p-8 text-left max-w-md mx-auto">
                  <p className="text-slate-200 text-sm font-semibold">Start a council run</p>
                  <ol className="text-slate-500 text-xs mt-3 space-y-2 list-decimal list-inside leading-relaxed">
                    <li>
                      Use <span className="text-slate-300">New chat</span> in the sidebar
                    </li>
                    <li>Choose a <span className="text-slate-300">text</span> chat model (not image-only)</li>
                    <li>Describe what you want built — the rest happens in the feed</li>
                  </ol>
                  <p className="text-slate-600 text-[11px] mt-4">
                    Chats are stored in{' '}
                    <code className="text-slate-500">data/sessions/</code> on the server.
                  </p>
                </div>
              )}
              {feed.length === 0 && sessionId && (
                <p className="text-slate-500 text-sm text-center max-w-sm mx-auto">
                  Send a message to continue, or open another chat from the list.
                </p>
              )}
              {feed.map((f) => (
                <article
                  key={f.id}
                  className={`max-w-2xl rounded-2xl px-3.5 py-2.5 ${
                    f.title === 'You'
                      ? 'ml-auto bg-violet-500/10 border border-violet-500/20'
                      : f.kind === 'err'
                        ? 'bg-rose-500/5 border border-rose-500/25'
                        : 'bg-slate-800/40 border border-slate-700/40'
                  }`}
                >
                  <div
                    className={`text-[10px] font-semibold tracking-wide uppercase ${
                      f.title === 'You' ? 'text-violet-300' : 'text-slate-400'
                    }`}
                  >
                    {f.title}
                  </div>
                  {f.body && (
                    <p className="text-slate-200/95 mt-1.5 text-sm leading-relaxed whitespace-pre-wrap">
                      {f.body}
                    </p>
                  )}
                </article>
              ))}
              {busy && (
                <div
                  className="rounded-xl border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs text-violet-200/90 flex items-center gap-2"
                  role="status"
                  aria-live="polite"
                >
                  <span className="flex gap-0.5" aria-hidden>
                    <span className="size-1.5 rounded-full bg-violet-400 animate-bounce [animation-delay:-0.2s]" />
                    <span className="size-1.5 rounded-full bg-violet-400 animate-bounce" />
                    <span className="size-1.5 rounded-full bg-violet-400 animate-bounce [animation-delay:0.2s]" />
                  </span>
                  Council is working…
                </div>
              )}
            </div>

            <div className="shrink-0 p-3 border-t border-white/5 bg-[#0a0a0c]/80">
              <div className="max-w-3xl mx-auto flex gap-2">
                <textarea
                  ref={composerRef}
                  className={`flex-1 min-h-[44px] max-h-32 rounded-xl border bg-slate-950/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-violet-500/35 disabled:opacity-50 ${
                    awaiting
                      ? 'border-amber-500/40 ring-1 ring-amber-500/20'
                      : 'border-slate-600/70'
                  }`}
                  placeholder={
                    awaiting
                      ? 'Reply to the council (they asked a question)…'
                      : 'Describe the idea — Enter to send, Shift+Enter for a new line'
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
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => void onSend()}
                    disabled={busy || !input.trim() || !model}
                    className="rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-30 px-4 py-2 text-sm font-medium text-white"
                  >
                    Send
                  </button>
                  {busy && (
                    <button
                      type="button"
                      onClick={stopStream}
                      className="text-xs text-slate-400 hover:text-white"
                    >
                      Stop
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Plan + research panel */}
          <div
            className="w-full lg:w-[min(100%,24rem)] shrink-0 flex flex-col min-h-0 max-h-[min(50dvh,22rem)] lg:max-h-none border-t lg:border-t-0 lg:border-l border-white/5 bg-[#0a0b0e]"
            role="complementary"
            aria-label="Research and plan"
          >
            <div className="hidden lg:block shrink-0 px-3 py-1.5 text-[10px] text-slate-500 uppercase border-b border-white/5">
              Research &amp; plan
            </div>
            <div
              className="shrink-0 flex lg:hidden border-b border-white/5"
              role="tablist"
              aria-label="Panel section"
            >
              <button
                type="button"
                role="tab"
                id="tab-research"
                aria-selected={rightPanelTab === 'research'}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  rightPanelTab === 'research'
                    ? 'text-violet-200 border-b-2 border-violet-500 bg-violet-500/5'
                    : 'text-slate-500 border-b-2 border-transparent'
                }`}
                onClick={() => setRightPanelTab('research')}
              >
                Research
                {research && (
                  <span className="ml-1.5 inline-flex size-1.5 rounded-full bg-emerald-400" />
                )}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-plan"
                aria-selected={rightPanelTab === 'plan'}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  rightPanelTab === 'plan'
                    ? 'text-violet-200 border-b-2 border-violet-500 bg-violet-500/5'
                    : 'text-slate-500 border-b-2 border-transparent'
                }`}
                onClick={() => setRightPanelTab('plan')}
              >
                Plan
                {planMd && (
                  <span className="ml-1.5 inline-flex size-1.5 rounded-full bg-violet-400" />
                )}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
              <div
                className={`
                ${rightPanelTab === 'research' ? 'block' : 'hidden'} lg:block
              `}
                role="tabpanel"
                aria-labelledby="tab-research"
              >
                {research ? (
                  <div>
                    <h3 className="text-xs font-medium text-slate-300">Sources</h3>
                    <ul className="mt-1.5 text-[11px] text-slate-500 space-y-1 max-h-32 lg:max-h-24 overflow-y-auto">
                      {research.sources?.slice(0, 12).map((s) => (
                        <li key={s.href}>
                          <a
                            href={s.href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-violet-400/90 hover:underline line-clamp-1"
                          >
                            {s.title || s.href}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                      {research.brief}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Web research summaries show here while the run collects sources.
                  </p>
                )}
              </div>
              <div
                className={`
                border-t border-white/5 pt-3
                ${rightPanelTab === 'plan' ? 'block' : 'hidden'} lg:block lg:border-t-0 lg:pt-0
              `}
                role="tabpanel"
                aria-labelledby="tab-plan"
              >
                <div className="flex justify-between items-center gap-2 mb-2">
                  <h3 className="text-xs font-medium text-slate-200">plan.md</h3>
                  {planMd && (
                    <button
                      type="button"
                      onClick={downloadPlan}
                      className="text-[10px] rounded-md border border-violet-500/30 px-2 py-1 text-violet-200 hover:bg-violet-500/10"
                    >
                      Download
                    </button>
                  )}
                </div>
                {planMd ? (
                  <pre className="text-[11px] text-slate-300/90 font-mono leading-relaxed whitespace-pre-wrap break-words max-h-[min(40dvh,18rem)] lg:max-h-[56vh] overflow-y-auto">
                    {planMd}
                  </pre>
                ) : (
                  <p className="text-xs text-slate-500">
                    The structured plan appears here when the council finishes a pass.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
