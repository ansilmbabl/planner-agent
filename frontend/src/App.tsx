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
  listCouncils,
  listSessions,
  patchSessionCouncil,
  type HealthResponse,
  type SessionListItem,
  type SessionMessage,
  type SseEvent,
  streamUserMessage,
} from './api'
import { MessageMarkdown } from './components/MessageMarkdown'
import { SettingsPanel } from './components/SettingsPanel'

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
      body: e.questions.map((q) => `- ${q}`).join('\n'),
    }
  }
  if (t === 'orchestrator') {
    const e = ev as {
      action: string
      reason?: string
      agent_ids?: string[]
      agent_id?: string | null
      step?: number
    }
    const ids =
      e.agent_ids?.length
        ? e.agent_ids.join(', ')
        : e.agent_id
          ? e.agent_id
          : ''
    const bits = [e.reason, ids ? `→ ${ids}` : ''].filter(Boolean).join(' ')
    return {
      kind: 'phase',
      title:
        e.step != null
          ? `Orchestrator (step ${e.step}) · ${e.action}`
          : `Orchestrator · ${e.action}`,
      body: bits,
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

function feedItemShell(
  kind: FeedItem['kind'],
  isUser: boolean,
  isErr: boolean
) {
  if (isUser) {
    return 'ml-auto max-w-[min(100%,36rem)] bg-violet-500/10 border border-violet-500/20 shadow-sm shadow-violet-950/25'
  }
  if (isErr) {
    return 'bg-rose-500/[0.06] border border-rose-500/25'
  }
  const base = 'max-w-3xl border bg-slate-800/35 shadow-sm'
  const accent: Record<FeedItem['kind'], string> = {
    phase: 'border-indigo-500/25 border-l-4 border-l-indigo-400/80 bg-indigo-950/25',
    research: 'border-cyan-500/20 border-l-4 border-l-cyan-500/60 bg-cyan-950/20',
    agent: 'border-slate-600/40 border-l-4 border-l-violet-500/65 bg-slate-800/50',
    synth: 'border-emerald-500/25 border-l-4 border-l-emerald-500/55 bg-emerald-950/20',
    await: 'border-amber-500/30 border-l-4 border-l-amber-400/80 bg-amber-950/25',
    err: 'border-rose-500/25',
    text: 'border-slate-600/40 border-l-4 border-l-slate-500/50',
  }
  return `${base} ${accent[kind]}`
}

function feedTitleClass(
  kind: FeedItem['kind'],
  isUser: boolean,
  isErr: boolean
) {
  if (isUser) return 'text-violet-200'
  if (isErr) return 'text-rose-300/95'
  const map: Record<FeedItem['kind'], string> = {
    phase: 'text-indigo-200/95',
    research: 'text-cyan-200/95',
    agent: 'text-violet-200/95',
    synth: 'text-emerald-200/95',
    await: 'text-amber-200/95',
    err: 'text-rose-300/95',
    text: 'text-slate-300/95',
  }
  return map[kind]
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
  const [councils, setCouncils] = useState<string[]>(['default'])
  const [councilForNew, setCouncilForNew] = useState('default')
  const [sessionCouncilId, setSessionCouncilId] = useState<string | null>(null)
  const [councilSelectError, setCouncilSelectError] = useState<string | null>(
    null
  )
  const [mainView, setMainView] = useState<'council' | 'settings'>('council')
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
  /** Session id for the in-flight /api/.../message stream (if any). */
  const streamOwnerSessionIdRef = useRef<string | null>(null)
  /** Synced to sessionId so event handlers can compare without stale closures. */
  const viewingSessionIdRef = useRef<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    viewingSessionIdRef.current = sessionId
  }, [sessionId])

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
    try {
      const cl = await listCouncils()
      if (cl.length) {
        setCouncils(cl)
        setCouncilForNew((cur) => (cur && cl.includes(cur) ? cur : cl[0]!))
      }
    } catch {
      setCouncils(['default'])
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
    if (mainView !== 'council') return
    void listCouncils()
      .then((cl) => {
        if (cl.length) {
          setCouncils(cl)
          setCouncilForNew((cur) => (cur && cl.includes(cur) ? cur : cl[0]!))
        }
      })
      .catch(() => {})
  }, [mainView])

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
    setCouncilSelectError(null)
    if (data.model) setModel(data.model)
    setSessionCouncilId(data.council_id || 'default')
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
      // Do not stop the stream — a run in another session should finish on the server
      // while the user views a different chat.
      try {
        const data = await getSession(id)
        setSessionId(id)
        hydrateFromApi(data)
        setMainView('council')
        setSidebarOpen(false)
        composerRef.current?.focus()
      } catch (e) {
        setModelHint(
          e instanceof Error ? e.message : 'Failed to open session'
        )
      }
    },
    [hydrateFromApi]
  )

  const newChat = useCallback(async () => {
    if (!model.trim()) {
      setModelHint('Pick a model first.')
      return
    }
    stopStream()
    try {
      const s = await createSession(model, councilForNew)
      setCouncilSelectError(null)
      setSessionId(s.id)
      setSessionCouncilId(s.council_id || councilForNew)
      clearWorkspace()
      await loadSessionList()
      setMainView('council')
      setSidebarOpen(false)
      composerRef.current?.focus()
    } catch (e) {
      setModelHint(
        e instanceof Error ? e.message : 'Could not start a new session'
      )
    }
  }, [model, councilForNew, clearWorkspace, loadSessionList, stopStream])

  const removeSession = useCallback(
    async (id: string, e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation()
      if (!window.confirm('Delete this chat and its saved history?')) return
      if (streamOwnerSessionIdRef.current === id) {
        stopStream()
      }
      try {
        await deleteSessionApi(id)
        if (sessionId === id) {
          setSessionId(null)
          setSessionCouncilId(null)
          setCouncilSelectError(null)
          clearWorkspace()
        }
        await loadSessionList()
      } catch (err) {
        setModelHint(
          err instanceof Error ? err.message : 'Delete failed'
        )
      }
    },
    [sessionId, clearWorkspace, loadSessionList, stopStream]
  )

  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId
    const s = await createSession(model, councilForNew)
    setCouncilSelectError(null)
    setSessionId(s.id)
    setSessionCouncilId(s.council_id || councilForNew)
    await loadSessionList()
    return s.id
  }, [sessionId, model, councilForNew, loadSessionList])

  const applyStreamToUi = () =>
    streamOwnerSessionIdRef.current != null &&
    streamOwnerSessionIdRef.current === viewingSessionIdRef.current

  const pushFeed = (ev: SseEvent) => {
    if (!ev || typeof ev !== 'object' || !('type' in ev)) return
    if (!applyStreamToUi()) return
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
      streamOwnerSessionIdRef.current = sid
      setFeed((f) => [
        ...f,
        { id: simpleId(), kind: 'text', title: 'You', body: text },
      ])
      for await (const ev of streamUserMessage(sid, text, model, ac.signal)) {
        if ((ev as { type?: string }).type === 'error') {
          if (applyStreamToUi()) {
            setFeed((f) => [
              ...f,
              {
                id: simpleId(),
                kind: 'err',
                title: 'Error',
                body: (ev as { message: string }).message,
              },
            ])
          }
          break
        }
        pushFeed(ev)
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        if (applyStreamToUi()) {
          setFeed((f) => [
            ...f,
            { id: simpleId(), kind: 'err', title: 'Stopped', body: 'Cancelled.' },
          ])
        }
      } else {
        if (applyStreamToUi()) {
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
      }
    } finally {
      streamAbort.current = null
      streamOwnerSessionIdRef.current = null
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
    <div className="h-dvh flex flex-col sm:flex-row bg-[#090a0d] text-slate-100 overflow-hidden selection:bg-violet-500/30">
      {/* Mobile: dim + close when tapping outside */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close chat list"
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — sessions */}
      <aside
        id="session-sidebar"
        className={`
        fixed z-40 inset-y-0 left-0 flex flex-col w-[min(100%,20rem)] border-r border-white/[0.06]
        bg-[#0c0e14] shadow-2xl shadow-black/50
        transition-transform duration-200 ease-out motion-reduce:transition-none
        sm:static sm:z-0 sm:w-[19rem] sm:max-h-none sm:shadow-none sm:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}
      `}
        aria-label="Chat history"
      >
        <div className="p-3.5 border-b border-white/[0.06] flex items-start gap-3">
          <div
            className="shrink-0 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/90 to-indigo-700/90 text-white shadow-md shadow-violet-950/40"
            aria-hidden
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
              />
            </svg>
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h1 className="text-[15px] font-semibold text-white tracking-tight leading-tight">
              Planner Council
            </h1>
            <p className="text-xs text-slate-500 leading-snug mt-0.5">
              Council → research →{' '}
              <span className="text-violet-300/95">plan.md</span>
            </p>
          </div>
        </div>
        <div className="p-2.5">
          <button
            type="button"
            onClick={() => void newChat()}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-[0.99] text-white text-sm font-medium py-2.5 px-3 shadow-lg shadow-violet-900/30 transition motion-reduce:transform-none"
          >
            <svg
              className="h-4 w-4 opacity-90"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
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
            <div className="mx-1 rounded-xl border border-dashed border-slate-600/40 bg-slate-900/20 px-3 py-3.5 text-xs text-slate-500 leading-relaxed">
              <p className="text-slate-400 font-medium text-[13px]">No sessions yet</p>
              <p className="mt-1.5 text-slate-500">
                Start a new chat — history is kept on this server so you can return anytime.
              </p>
            </div>
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
                  group w-full text-left rounded-xl px-2.5 py-2.5 pr-1 flex gap-1 items-start
                  transition-[background,border,box-shadow] duration-150
                  focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-500/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c0e14]
                  ${
                    active
                      ? 'bg-violet-500/[0.12] border border-violet-500/35 shadow-sm shadow-violet-950/20'
                      : 'hover:bg-white/[0.04] border border-transparent hover:border-white/[0.06]'
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
                    <span
                      className="text-slate-600 truncate max-w-[4.5rem]"
                      title="Council"
                    >
                      {s.council_id ?? 'default'}
                    </span>
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
        <div className="shrink-0 border-t border-white/[0.06] p-2.5">
          <button
            type="button"
            onClick={() => {
              setMainView('settings')
              setSidebarOpen(false)
            }}
            className={`
              w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors
              ${
                mainView === 'settings'
                  ? 'bg-violet-500/18 text-violet-100 border border-violet-500/35'
                  : 'text-slate-300 hover:bg-white/[0.05] border border-transparent hover:border-white/[0.06]'
              }
            `}
          >
            <span className="flex items-center gap-2">
              <svg
                className="h-4 w-4 text-slate-500 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.6.9.55.45 1.162.86 1.82 1.22.32.19.55.5.6.9l.213 1.28c.09.54-.2 1.05-.67 1.3l-1.4.8c-.4.24-.6.7-.5 1.16.15.6.25 1.22.3 1.86.04.4.3.75.7.88l1.4.4c.5.15.9.57 1.05 1.1l.6 1.8c.15.5-.1 1.05-.55 1.3L18.1 20.1c-.45.3-1.02.2-1.4-.2l-1.15-1.1c-.32-.3-.8-.4-1.2-.2-.5.2-1.02.4-1.55.5-.4.1-.7.4-.8.8l-.3 1.2c-.1.5-.5.9-1 .95l-1.7.1c-.55.05-1.05-.3-1.2-.8l-.3-1.1c-.1-.45-.5-.8-1-.9-.2-.02-.4-.04-.6-.1-.1-.02-.2-.04-.3-.1l-1.2.5c-.5.2-1.1.05-1.4-.4l-1-1.4c-.3-.4-.25-1.05.1-1.4l.9-1.05c.25-.3.3-.7.1-1.1-.1-.2-.2-.4-.3-.6-.15-.4-.2-.8-.1-1.2l.3-1.2c.1-.4-.05-.85-.4-1.1l-1.2-.9c-.45-.35-.6-.95-.35-1.45l.6-1.8c.15-.5.6-.9 1.1-1.05l1.4-.4c.4-.1.7-.5.7-.9.05-.55.1-1.1.2-1.64.1-.4-.05-.85-.4-1.1L9.2 4.2c-.45-.3-.6-.9-.4-1.4L9.2 1.1c.1-.5.5-.9 1-.95H9.4zM12 15a3 3 0 100-6 3 3 0 000 6z"
                />
              </svg>
              Settings
            </span>
            <span className="block text-[11px] font-normal text-slate-500 mt-0.5 pl-6">
              Ollama and council agents
            </span>
          </button>
        </div>
      </aside>

      <div
        className="flex-1 flex flex-col min-w-0 min-h-0"
        aria-busy={busy && mainView === 'council'}
      >
        {mainView === 'council' && (
          <header className="shrink-0 border-b border-white/[0.06] bg-[#090a0d]/85 backdrop-blur-md px-3 py-2.5 sm:px-4 flex flex-wrap items-center gap-2.5 z-10">
            <button
              type="button"
              className="sm:hidden rounded-lg border border-slate-600/50 bg-slate-900/50 px-2.5 py-2 text-xs font-medium text-slate-200 touch-manipulation"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-expanded={sidebarOpen}
              aria-controls="session-sidebar"
              aria-label={sidebarOpen ? 'Close chat list' : 'Open chat list'}
            >
              {sidebarOpen ? 'Close' : 'Chats'}
            </button>
            <div className="min-w-0 flex-1 sm:flex-initial sm:min-w-0">
              <div className="text-sm font-semibold text-slate-100 tracking-tight">
                Council workspace
              </div>
              <p className="text-[11px] text-slate-500 leading-snug hidden sm:block mt-0.5">
                Chat, research, and <span className="text-violet-300/90">plan output</span>
              </p>
            </div>
            <div
              className={`
                inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium max-w-[min(52vw,14rem)] shrink-0
                ${
                  ollamaOk
                    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200/95'
                    : oll?.reachable === false
                      ? 'border-rose-500/30 bg-rose-500/10 text-rose-200/90'
                      : 'border-amber-500/30 bg-amber-500/10 text-amber-200/90'
                }
              `}
              title={
                ollamaOk
                  ? `Ollama · ${oll?.model_count ?? 0} models`
                  : (oll?.error as string) || 'LLM status'
              }
            >
              <span
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  ollamaOk
                    ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]'
                    : oll?.reachable === false
                      ? 'bg-rose-400'
                      : 'bg-amber-400'
                }`}
                aria-hidden
              />
              <span className="truncate">
                {ollamaOk
                  ? `Ollama · ${oll?.model_count ?? 0} model${(oll?.model_count ?? 0) === 1 ? '' : 's'}`
                  : oll?.reachable === false
                    ? 'Ollama offline'
                    : 'Checking…'}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 min-w-0 shrink max-w-[min(42vw,9.5rem)] sm:max-w-[11rem]">
              <label className="flex items-center gap-1.5 min-w-0">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-medium hidden sm:inline shrink-0">
                  Council
                </span>
                <select
                  className="min-w-0 flex-1 text-xs leading-tight py-1.5 px-2 rounded-lg border border-slate-600/60 bg-slate-900/80 text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/35 focus:ring-offset-0 disabled:opacity-50"
                  value={
                    sessionId
                      ? (sessionCouncilId ?? 'default')
                      : councilForNew
                  }
                  onChange={(e) => {
                    const v = e.target.value
                    setCouncilSelectError(null)
                    if (!sessionId) {
                      setCouncilForNew(v)
                      return
                    }
                    const prev = sessionCouncilId ?? 'default'
                    setSessionCouncilId(v)
                    setCouncilForNew(v)
                    void (async () => {
                      try {
                        await patchSessionCouncil(sessionId, v)
                      } catch (err) {
                        setSessionCouncilId(prev)
                        setCouncilForNew(prev)
                        setCouncilSelectError(
                          err instanceof Error
                            ? err.message
                            : 'Could not update council'
                        )
                      }
                    })()
                  }}
                  disabled={busy}
                  title={
                    busy
                      ? 'Wait until the current run finishes'
                      : sessionId
                        ? 'Council for this chat — applies to the next message (config/councils/<id>.json)'
                        : 'Agent council for the next new chat'
                  }
                  aria-label="Council"
                >
                  {councils.length === 0 && (
                    <option value="default">default</option>
                  )}
                  {councils.map((cid) => (
                    <option key={cid} value={cid}>
                      {cid}
                    </option>
                  ))}
                </select>
              </label>
              {councilSelectError && (
                <span
                  className="text-[10px] text-rose-300/95 truncate sm:pl-1"
                  title={councilSelectError}
                >
                  {councilSelectError}
                </span>
              )}
            </div>
            <label className="flex items-center gap-2 min-w-0 grow sm:grow-0 sm:shrink sm:max-w-[min(50vw,16rem)]">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-medium hidden sm:inline shrink-0">
                Model
              </span>
              <select
                className="min-w-0 flex-1 text-xs leading-tight py-1.5 px-2.5 rounded-lg border border-slate-600/60 bg-slate-900/80 text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/35 focus:ring-offset-0 disabled:opacity-40"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy}
                title="Model for new messages"
                aria-label="Model"
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
                setMainView('settings')
                setSidebarOpen(false)
              }}
              className="text-xs font-medium rounded-lg border border-slate-600/50 bg-slate-900/40 px-3 py-1.5 text-slate-200 hover:bg-white/[0.06] shrink-0"
            >
              Settings
            </button>
          </header>
        )}

        {mainView === 'council' && (ollamaHostReachable || modelHint) && (
          <div className="shrink-0 mx-3 mt-2 flex flex-wrap items-center gap-2.5 text-xs text-amber-100/95 rounded-xl border border-amber-500/25 bg-amber-950/30 px-3 py-2.5 shadow-sm">
            <span className="min-w-0 flex-1 leading-relaxed text-[13px]">
              {modelHint ||
                (ollamaHostReachable
                  ? 'Ollama is up but no text models are listed.'
                  : '')}
            </span>
            <button
              type="button"
              className="shrink-0 text-amber-100 underline underline-offset-2"
              onClick={() => {
                setMainView('settings')
                setSidebarOpen(false)
              }}
            >
              Open Settings
            </button>
            {modelHint && (
              <button
                type="button"
                className="shrink-0 text-slate-500 hover:text-slate-300"
                onClick={() => setModelHint(null)}
              >
                Dismiss
              </button>
            )}
          </div>
        )}

        {mainView === 'settings' ? (
          <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
            <SettingsPanel
              health={health}
              modelHint={modelHint}
              ollamaHostReachable={ollamaHostReachable}
              onRefresh={() => {
                void refreshConnection()
                void loadSessionList()
              }}
              busy={busy}
              onBack={() => setMainView('council')}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
          </div>
        ) : (
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
          {/* Messages */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 border-b lg:border-b-0 lg:border-r border-white/5">
            <div className="shrink-0 flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 border-b border-white/[0.06] bg-[#08090c]/50">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  Conversation
                </div>
                {sessionId && (
                  <div className="mt-1 text-sm text-slate-100 font-medium line-clamp-1 pr-1">
                    {currentSessionTitle || 'New session'}
                  </div>
                )}
              </div>
              {sessionId && (
                <div className="flex flex-col items-end gap-0.5 shrink-0 min-w-0">
                  {phase && (
                    <span
                      className="text-[10px] font-medium text-violet-300/95 max-w-[9rem] sm:max-w-[12rem] truncate text-right"
                      title={phase}
                    >
                      {phase}
                    </span>
                  )}
                  <span
                    className="text-slate-600 font-mono text-[10px] truncate max-w-[4.5rem] sm:max-w-[9rem] hidden sm:block"
                    title={sessionId}
                  >
                    {sessionId}
                  </span>
                </div>
              )}
            </div>
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto scroll-smooth scroll-pb-4 px-3 sm:px-4 py-4 space-y-3.5 [scrollbar-gutter:stable]"
            >
              {feed.length === 0 && !sessionId && (
                <div className="rounded-2xl border border-slate-600/30 bg-gradient-to-b from-slate-900/50 to-slate-950/40 p-6 sm:p-8 text-left max-w-md mx-auto shadow-lg shadow-black/20">
                  <p className="text-slate-100 text-base font-semibold tracking-tight">
                    Start a council run
                  </p>
                  <p className="text-slate-500 text-sm mt-2 leading-relaxed">
                    The council debates, pulls research, then writes a structured plan.
                  </p>
                  <ol className="text-slate-400 text-sm mt-4 space-y-2.5 list-decimal list-inside leading-relaxed">
                    <li>
                      Click <span className="text-slate-200 font-medium">New chat</span> in the sidebar
                    </li>
                    <li>
                      Pick a <span className="text-slate-200 font-medium">text</span> model in the header
                    </li>
                    <li>Describe what you want — updates stream into this thread</li>
                  </ol>
                  <p className="text-slate-500 text-xs mt-5 pt-4 border-t border-white/[0.06]">
                    History is stored in the API&apos;s <code className="text-slate-400">SQLite</code>{' '}
                    database.
                  </p>
                </div>
              )}
              {feed.length === 0 && sessionId && (
                <p className="text-slate-500 text-sm text-center max-w-sm mx-auto leading-relaxed">
                  Send a message to continue, or choose another chat in the list.
                </p>
              )}
              {feed.map((f) => {
                const isUser = f.title === 'You'
                const isErr = f.kind === 'err'
                return (
                  <article
                    key={f.id}
                    className={`max-w-2xl rounded-2xl px-3.5 py-3 ${feedItemShell(f.kind, isUser, isErr)}`}
                  >
                    <div
                      className={`text-[11px] font-semibold tracking-tight ${feedTitleClass(
                        f.kind,
                        isUser,
                        isErr
                      )}`}
                    >
                      {f.title}
                    </div>
                    {f.body && (
                      <div
                        className={
                          isUser
                            ? '[&_a]:text-violet-300 [&_a]:decoration-violet-400/40'
                            : undefined
                        }
                      >
                        <MessageMarkdown
                          text={f.body}
                          plain={isErr}
                          size="message"
                        />
                      </div>
                    )}
                  </article>
                )
              })}
              {busy && (
                <div
                  className="rounded-xl border border-violet-500/30 bg-violet-500/10 px-3.5 py-2.5 text-sm text-violet-100/95 flex items-center gap-2.5"
                  role="status"
                  aria-live="polite"
                >
                  <span className="flex gap-0.5" aria-hidden>
                    <span className="size-1.5 rounded-full bg-violet-300 animate-bounce [animation-delay:-0.2s]" />
                    <span className="size-1.5 rounded-full bg-violet-300 animate-bounce" />
                    <span className="size-1.5 rounded-full bg-violet-300 animate-bounce [animation-delay:0.2s]" />
                  </span>
                  Council is working…
                </div>
              )}
            </div>

            <div className="shrink-0 p-3 sm:p-4 border-t border-white/[0.06] bg-[#07080b]/90 backdrop-blur-sm">
              <div className="max-w-3xl mx-auto flex flex-col sm:flex-row gap-2.5 sm:items-end sm:gap-3">
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <textarea
                    ref={composerRef}
                    className={`w-full min-h-[48px] max-h-36 rounded-xl border bg-slate-950/70 px-3.5 py-3 text-sm text-slate-100 placeholder:text-slate-500 shadow-inner shadow-black/20 focus:outline-none focus:ring-2 focus:ring-offset-0 focus:ring-violet-500/40 disabled:opacity-50 resize-y ${
                      awaiting
                        ? 'border-amber-500/50 ring-1 ring-amber-500/15'
                        : 'border-slate-600/60'
                    }`}
                    placeholder={
                      awaiting
                        ? 'Reply to the council (they asked a question)…'
                        : 'Describe your goal or answer the council…'
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
                    rows={2}
                    aria-label="Message"
                  />
                  <p className="text-[11px] text-slate-500 px-0.5 leading-relaxed">
                    Markdown supported. <kbd className="kbd-hint">Enter</kbd> send ·{' '}
                    <kbd className="kbd-hint">Shift+Enter</kbd> newline
                    {busy && (
                      <span className="text-amber-200/80">
                        {' '}
                        · run in progress — use Stop to cancel
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex sm:flex-col gap-2 sm:gap-1.5 shrink-0 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => void onSend()}
                    disabled={busy || !input.trim() || !model}
                    title="Send (Enter)"
                    className="flex-1 sm:flex-initial rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-[0.99] disabled:opacity-35 disabled:hover:bg-violet-600 px-4 py-2.5 sm:px-5 text-sm font-medium text-white shadow-md shadow-violet-950/30 motion-reduce:transform-none"
                  >
                    Send
                  </button>
                  {busy && (
                    <button
                      type="button"
                      onClick={stopStream}
                      className="text-sm text-slate-400 hover:text-white py-2 sm:py-0 underline-offset-2 hover:underline"
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
            className="w-full lg:w-[min(100%,26rem)] shrink-0 flex flex-col min-h-0 max-h-[min(46dvh,24rem)] lg:max-h-none border-t lg:border-t-0 lg:border-l border-white/[0.06] bg-[#08090c]"
            role="complementary"
            aria-label="Research and plan"
          >
            <div
              className="shrink-0 flex border-b border-white/[0.06] bg-[#0a0b0e]/80 p-1 gap-0.5"
              role="tablist"
              aria-label="Output panel"
            >
              <button
                type="button"
                role="tab"
                id="tab-research"
                aria-selected={rightPanelTab === 'research'}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors ${
                  rightPanelTab === 'research'
                    ? 'text-violet-100 bg-violet-500/20 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
                }`}
                onClick={() => setRightPanelTab('research')}
              >
                Research
                {research && (
                  <span
                    className="inline-flex size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.45)]"
                    title="Has content"
                  />
                )}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-plan"
                aria-selected={rightPanelTab === 'plan'}
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium transition-colors ${
                  rightPanelTab === 'plan'
                    ? 'text-violet-100 bg-violet-500/20 shadow-sm'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
                }`}
                onClick={() => setRightPanelTab('plan')}
              >
                Plan
                {planMd && (
                  <span
                    className="inline-flex size-1.5 rounded-full bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.4)]"
                    title="Has content"
                  />
                )}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4">
              <div
                className={rightPanelTab === 'research' ? 'block' : 'hidden'}
                role="tabpanel"
                aria-labelledby="tab-research"
              >
                {research ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                      Sources
                    </h3>
                    <ul className="mt-2 text-xs text-slate-400 space-y-1.5 max-h-36 lg:max-h-28 overflow-y-auto">
                      {research.sources?.slice(0, 12).map((s) => (
                        <li key={s.href}>
                          <a
                            href={s.href}
                            target="_blank"
                            rel="noreferrer"
                            className="text-violet-300/90 hover:text-violet-200 hover:underline line-clamp-2 leading-snug"
                          >
                            {s.title || s.href}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 pt-3 border-t border-white/[0.06] text-slate-200/95">
                      <MessageMarkdown text={research.brief} size="panel" />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-600/35 bg-slate-900/20 px-3 py-4">
                    <p className="text-sm text-slate-400 leading-relaxed">
                      Research briefs and source links show here while the run collects context.
                    </p>
                  </div>
                )}
              </div>
              <div
                className={rightPanelTab === 'plan' ? 'block' : 'hidden'}
                role="tabpanel"
                aria-labelledby="tab-plan"
              >
                <div className="flex justify-between items-center gap-2 mb-2.5">
                  <h3 className="text-sm font-semibold text-slate-100">Plan document</h3>
                  {planMd && (
                    <button
                      type="button"
                      onClick={downloadPlan}
                      className="text-xs font-medium rounded-lg border border-violet-500/35 bg-violet-500/10 px-2.5 py-1.5 text-violet-200 hover:bg-violet-500/20"
                    >
                      Download
                    </button>
                  )}
                </div>
                {planMd ? (
                  <div className="max-h-[min(36dvh,16rem)] lg:max-h-[min(60vh,28rem)] overflow-y-auto rounded-xl border border-slate-700/40 bg-slate-950/40 p-3 shadow-inner">
                    <MessageMarkdown text={planMd} size="panel" />
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-600/35 bg-slate-900/20 px-3 py-4">
                    <p className="text-sm text-slate-500 leading-relaxed">
                      The structured plan will appear when the council finishes a synthesis pass.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}
