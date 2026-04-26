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
  getCouncil,
  getHealth,
  getModels,
  getSession,
  listCouncils,
  listSessions,
  patchSessionCouncil,
  type CouncilConfig,
  type HealthResponse,
  type SessionListItem,
  type SessionMessage,
  type SseEvent,
  streamRefinePlan,
  streamUserMessage,
} from './api'
import { mergeCouncilDefaults } from './agentsConfigUtils'
import { MessageMarkdown } from './components/MessageMarkdown'
import { SettingsPanel } from './components/SettingsPanel'

type FeedLane = 'chat' | 'process'

type FeedItem = {
  id: string
  lane: FeedLane
  kind: 'phase' | 'research' | 'agent' | 'synth' | 'await' | 'err' | 'text'
  title: string
  body?: string
}

function simpleId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function eventLabel(ev: SseEvent): {
  title: string
  body: string
  kind: FeedItem['kind']
  lane: FeedLane
} {
  if (!ev || typeof ev !== 'object' || !('type' in ev)) {
    return {
      title: 'Event',
      body: JSON.stringify(ev),
      kind: 'text',
      lane: 'process',
    }
  }
  const t = (ev as { type: string }).type
  if (t === 'phase') {
    const e = ev as { phase: string; message?: string; round?: number }
    return {
      kind: 'phase',
      lane: 'process',
      title: e.message || e.phase || 'Phase',
      body:
        e.round != null
          ? `Round ${e.round} · ${e.phase}`
          : (e.phase ?? ''),
    }
  }
  if (t === 'research') {
    const e = ev as { brief: string }
    const brief = (e.brief || '').trim()
    const oneLine =
      brief.length > 140 ? `${brief.slice(0, 137).trim()}…` : brief
    return {
      kind: 'research',
      lane: 'process',
      title: 'Web research',
      body: oneLine
        ? `${oneLine}\n\n_Full summary and sources are in the **Research** tab._`
        : 'Brief updated — see **Research** tab.',
    }
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
    return {
      kind: 'agent',
      lane: 'process',
      title: `Specialist · round ${e.round} · ${e.name}`,
      body,
    }
  }
  if (t === 'awaiting_user') {
    const e = ev as { questions: string[] }
    return {
      kind: 'await',
      lane: 'chat',
      title: 'Reply needed',
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
      lane: 'process',
      title:
        e.step != null
          ? `Routing · step ${e.step} · ${e.action}`
          : `Routing · ${e.action}`,
      body: bits,
    }
  }
  if (t === 'synth') {
    const e = ev as { summary: string }
    return {
      kind: 'synth',
      lane: 'process',
      title: 'Synthesizer',
      body: e.summary,
    }
  }
  if (t === 'orchestrator_reply') {
    const e = ev as { content: string }
    return {
      kind: 'text',
      lane: 'chat',
      title: 'Orchestrator',
      body: e.content,
    }
  }
  if (t === 'error') {
    const e = ev as { message: string }
    return { kind: 'err', lane: 'chat', title: 'Error', body: e.message }
  }
  if (t === 'plan') {
    return {
      kind: 'text',
      lane: 'chat',
      title: 'Plan ready',
      body: 'Open the **Plan** tab on the right to preview and download.',
    }
  }
  if (t === 'stream_end') {
    return { kind: 'phase', lane: 'process', title: '', body: '' }
  }
  if (t === 'done') {
    return {
      kind: 'phase',
      lane: 'process',
      title: 'Ready',
      body:
        'You can refine the plan (Plan tab), send a new message to start a fresh council run, or open a new chat.',
    }
  }
  return {
    kind: 'text',
    lane: 'process',
    title: t,
    body: JSON.stringify(ev),
  }
}

function truncateProcessBody(s: string, max = 200): string {
  const t = (s || '').trim()
  if (!t) return ''
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trim()}…`
}

function sessionMessagesToFeed(msgs: SessionMessage[]): FeedItem[] {
  if (!msgs?.length) return []
  return msgs.map((m, i) => {
    const id = `hist-${i}-${(m.content || '').slice(0, 6)}`
    if (m.role === 'user') {
      return {
        id,
        lane: 'chat' as const,
        kind: 'text' as const,
        title: 'You',
        body: m.content,
      }
    }
    if (m.role !== 'assistant') {
      return {
        id,
        lane: 'chat' as const,
        kind: 'text' as const,
        title: m.role,
        body: m.content,
      }
    }
    const aid = String(m.agent_id || '').toLowerCase()
    const an = String(m.agent_name || '').trim()
    const action =
      m.meta && typeof m.meta.action === 'string' ? m.meta.action : ''
    const metaKind =
      m.meta && typeof (m.meta as { kind?: unknown }).kind === 'string'
        ? String((m.meta as { kind: string }).kind)
        : ''

    if (metaKind === 'plan_refine_request') {
      return {
        id,
        lane: 'chat',
        kind: 'text',
        title: 'You · refine plan',
        body: m.content,
      }
    }
    if (metaKind === 'plan_refine' || aid === 'plan_refine') {
      return {
        id,
        lane: 'chat',
        kind: 'text',
        title: an || 'Plan refine',
        body: m.content,
      }
    }

    if (aid === 'system' && (an === 'Research' || an.toLowerCase() === 'research')) {
      return {
        id,
        lane: 'process',
        kind: 'research',
        title: 'Research',
        body: truncateProcessBody(m.content, 220)
          ? `${truncateProcessBody(m.content, 220)}\n\n_Full text in **Research** tab._`
          : 'Brief updated — see **Research** tab.',
      }
    }
    if (aid === 'planner' || /planner/i.test(an)) {
      return {
        id,
        lane: 'chat',
        kind: 'text',
        title: an || 'Planner',
        body: m.content,
      }
    }
    if (action === 'ask_user') {
      return {
        id,
        lane: 'chat',
        kind: 'await',
        title: 'Reply needed',
        body: m.content,
      }
    }
    if (action === 'orchestrator_reply' || aid === 'orchestrator') {
      return {
        id,
        lane: 'chat',
        kind: 'text',
        title: an || 'Orchestrator',
        body: m.content,
      }
    }
    if (/synth/i.test(an) || /synth/i.test(aid) || /align/i.test(an)) {
      return {
        id,
        lane: 'process',
        kind: 'synth',
        title: an || 'Synthesizer',
        body: m.content,
      }
    }
    return {
      id,
      lane: 'process',
      kind: 'agent',
      title: an || aid || 'Specialist',
      body: m.content,
    }
  })
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
    return 'ml-auto max-w-[min(90%,30rem)] rounded-[1.35rem] rounded-br-md bg-gradient-to-br from-violet-600/35 to-violet-700/20 border border-violet-400/20 shadow-md shadow-black/25'
  }
  if (isErr) {
    return 'max-w-[min(90%,32rem)] rounded-2xl bg-rose-500/[0.07] border border-rose-400/20'
  }
  const base =
    'max-w-[min(90%,32rem)] rounded-[1.35rem] rounded-bl-md border shadow-sm bg-slate-900/40'
  const accent: Record<FeedItem['kind'], string> = {
    phase: 'border-white/[0.08]',
    research: 'border-cyan-500/15 bg-cyan-950/15',
    agent: 'border-violet-500/15 bg-violet-950/10',
    synth: 'border-emerald-500/15 bg-emerald-950/10',
    await:
      'border-amber-400/25 bg-amber-950/20 ring-1 ring-amber-500/10',
    err: 'border-rose-500/25',
    text: 'border-white/[0.08]',
  }
  return `${base} ${accent[kind]}`
}

function feedTitleClass(
  kind: FeedItem['kind'],
  isUser: boolean,
  isErr: boolean
) {
  if (isUser) return 'text-violet-100/95 text-xs font-medium'
  if (isErr) return 'text-rose-200/95 text-xs font-semibold'
  const map: Record<FeedItem['kind'], string> = {
    phase: 'text-slate-400 text-xs font-medium',
    research: 'text-cyan-200/90 text-xs font-medium',
    agent: 'text-violet-200/90 text-xs font-medium',
    synth: 'text-emerald-200/90 text-xs font-medium',
    await: 'text-amber-100/95 text-xs font-semibold',
    err: 'text-rose-300/95',
    text: 'text-slate-200 text-xs font-medium',
  }
  return map[kind]
}

function processDotClass(kind: FeedItem['kind']): string {
  switch (kind) {
    case 'phase':
      return 'bg-indigo-400 shadow-[0_0_6px_rgba(129,140,248,0.45)]'
    case 'research':
      return 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.35)]'
    case 'agent':
      return 'bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.4)]'
    case 'synth':
      return 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.35)]'
    default:
      return 'bg-slate-500'
  }
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
  /** Routing / research / specialists — separate from chat bubbles */
  const [showProcessDetail, setShowProcessDetail] = useState(false)
  const [councilDetail, setCouncilDetail] = useState<CouncilConfig | null>(null)
  const [refineInstruction, setRefineInstruction] = useState('')
  const [refineSelection, setRefineSelection] = useState('')
  const [refineAgentIds, setRefineAgentIds] = useState<string[]>(['orchestrator'])

  const streamAbort = useRef<AbortController | null>(null)
  const planPreviewRef = useRef<HTMLDivElement | null>(null)
  /** Session id for the in-flight /api/.../message stream (if any). */
  const streamOwnerSessionIdRef = useRef<string | null>(null)
  /** Synced to sessionId so event handlers can compare without stale closures. */
  const viewingSessionIdRef = useRef<string | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    viewingSessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    setRefineInstruction('')
    setRefineSelection('')
  }, [sessionId])

  useEffect(() => {
    if (!sessionCouncilId) {
      setCouncilDetail(null)
      return
    }
    let live = true
    void getCouncil(sessionCouncilId)
      .then((raw) => {
        if (!live) return
        const merged = mergeCouncilDefaults(raw)
        setCouncilDetail(merged)
        const orchId = merged.orchestrator?.id
        const allowed = new Set<string>([
          ...(merged.orchestrator ? [merged.orchestrator.id] : []),
          ...merged.debating_agents.map((d) => d.id),
          ...(merged.synthesizer ? [merged.synthesizer.id] : []),
        ])
        setRefineAgentIds((prev) => {
          const next = prev.filter((id) => allowed.has(id))
          if (next.length) return next
          return orchId ? [orchId] : []
        })
      })
      .catch(() => {
        if (live) setCouncilDetail(null)
      })
    return () => {
      live = false
    }
  }, [sessionCouncilId])

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
          lane: mapped.lane,
          kind: mapped.kind,
          title: mapped.title,
          body: mapped.body,
        },
      ])
    }
  }

  const toggleRefineAgent = useCallback((id: string) => {
    setRefineAgentIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return prev.filter((x) => x !== id)
      }
      return [...prev, id]
    })
  }, [])

  const capturePlanSelection = useCallback(() => {
    const el = planPreviewRef.current
    let t = ''
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (sel && el && sel.anchorNode && el.contains(sel.anchorNode)) {
      t = (sel.toString() || '').trim()
    } else if (sel) {
      t = (sel.toString() || '').trim()
    }
    if (t) setRefineSelection(t)
  }, [])

  async function onRefinePlan() {
    const inst = refineInstruction.trim()
    if (!inst || busy || !sessionId) return
    if (!model.trim()) {
      setModelHint('Select a model from the list.')
      return
    }
    setBusy(true)
    const ac = new AbortController()
    streamAbort.current = ac
    streamOwnerSessionIdRef.current = sessionId
    try {
      const selEx = refineSelection.trim()
      const bodyPreview =
        inst +
        (selEx
          ? `\n\n_Excerpt:_\n${selEx.length > 400 ? `${selEx.slice(0, 397)}…` : selEx}`
          : '')
      setFeed((f) => [
        ...f,
        {
          id: simpleId(),
          lane: 'chat',
          kind: 'text',
          title: 'You · refine plan',
          body: bodyPreview,
        },
      ])
      for await (const ev of streamRefinePlan(
        sessionId,
        {
          instruction: inst,
          selection: selEx || undefined,
          agent_ids: refineAgentIds.length ? refineAgentIds : undefined,
          model,
        },
        ac.signal
      )) {
        if ((ev as { type?: string }).type === 'error') {
          if (applyStreamToUi()) {
            setFeed((f) => [
              ...f,
              {
                id: simpleId(),
                lane: 'chat',
                kind: 'err',
                title: 'Refine failed',
                body: (ev as { message: string }).message,
              },
            ])
          }
          break
        }
        pushFeed(ev)
      }
      setRefineInstruction('')
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        if (applyStreamToUi()) {
          setFeed((f) => [
            ...f,
            {
              id: simpleId(),
              lane: 'chat',
              kind: 'err',
              title: 'Stopped',
              body: 'Cancelled.',
            },
          ])
        }
      } else if (applyStreamToUi()) {
        setFeed((f) => [
          ...f,
          {
            id: simpleId(),
            lane: 'chat',
            kind: 'err',
            title: 'Refine failed',
            body: e instanceof Error ? e.message : String(e),
          },
        ])
      }
    } finally {
      streamAbort.current = null
      streamOwnerSessionIdRef.current = null
      setBusy(false)
      void loadSessionList()
    }
  }

  async function onSend() {
    const text = input.trim()
    if (!text || busy) return
    if (
      phase === 'done' &&
      planMd.trim() &&
      !window.confirm(
        'A new chat message starts a fresh council run and clears this session’s plan and research. For targeted edits, use **Refine plan** in the Plan tab. Continue with a new run?'
      )
    ) {
      return
    }
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
        {
          id: simpleId(),
          lane: 'chat',
          kind: 'text',
          title: 'You',
          body: text,
        },
      ])
      for await (const ev of streamUserMessage(sid, text, model, ac.signal)) {
        if ((ev as { type?: string }).type === 'error') {
          if (applyStreamToUi()) {
            setFeed((f) => [
              ...f,
              {
                id: simpleId(),
                lane: 'chat',
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
            {
              id: simpleId(),
              lane: 'chat',
              kind: 'err',
              title: 'Stopped',
              body: 'Cancelled.',
            },
          ])
        }
      } else {
        if (applyStreamToUi()) {
          setFeed((f) => [
            ...f,
            {
              id: simpleId(),
              lane: 'chat',
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

  const processStepCount = useMemo(
    () => feed.filter((x) => x.lane === 'process').length,
    [feed]
  )

  return (
    <div className="h-dvh flex flex-col sm:flex-row text-slate-100 overflow-hidden selection:bg-violet-500/25">
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
        fixed z-40 inset-y-0 left-0 flex flex-col w-[min(100%,19rem)] border-r border-white/[0.07]
        bg-[#0e1017]/92 backdrop-blur-xl shadow-2xl shadow-black/40
        transition-transform duration-200 ease-out motion-reduce:transition-none
        sm:static sm:z-0 sm:w-[17.5rem] sm:max-h-none sm:shadow-none sm:translate-x-0
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}
      `}
        aria-label="Chat history"
      >
        <div className="p-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div
              className="shrink-0 flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-900/30"
              aria-hidden
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-white tracking-tight">Planner</h1>
              <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                Chats &amp; councils
              </p>
            </div>
          </div>
        </div>
        <div className="px-3 pt-3 pb-2">
          <button
            type="button"
            onClick={() => void newChat()}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium py-2.5 px-3 shadow-md shadow-violet-950/25 transition active:scale-[0.99] motion-reduce:transform-none"
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
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 pb-3 space-y-1">
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
                  group w-full text-left rounded-xl px-3 py-2.5 pr-1 flex gap-2 items-start
                  transition-[background,border] duration-150
                  focus-visible:outline focus-visible:ring-2 focus-visible:ring-violet-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1017]
                  ${
                    active
                      ? 'bg-white/[0.06] border border-violet-500/30'
                      : 'hover:bg-white/[0.04] border border-transparent'
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
        <div className="shrink-0 border-t border-white/[0.06] p-3">
          <button
            type="button"
            onClick={() => {
              setMainView('settings')
              setSidebarOpen(false)
            }}
            className={`
              w-full rounded-xl px-3 py-2.5 text-left text-sm transition-colors
              ${
                mainView === 'settings'
                  ? 'bg-violet-500/15 text-violet-100 ring-1 ring-violet-500/35'
                  : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
              }
            `}
          >
            <span className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.06] text-slate-400">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </span>
              <span>
                <span className="font-medium text-slate-200">Settings</span>
                <span className="block text-[11px] text-slate-500 mt-0.5">Model &amp; agents</span>
              </span>
            </span>
          </button>
        </div>
      </aside>

      <div
        className="flex-1 flex flex-col min-w-0 min-h-0"
        aria-busy={busy && mainView === 'council'}
      >
        {mainView === 'council' && (
          <header className="shrink-0 border-b border-white/[0.06] bg-[#0a0b10]/80 backdrop-blur-md px-3 py-3 sm:px-5 flex flex-wrap items-center gap-3 z-10">
            <button
              type="button"
              className="sm:hidden rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-slate-200 touch-manipulation"
              onClick={() => setSidebarOpen((o) => !o)}
              aria-expanded={sidebarOpen}
              aria-controls="session-sidebar"
              aria-label={sidebarOpen ? 'Close chat list' : 'Open chat list'}
            >
              {sidebarOpen ? 'Close' : 'Chats'}
            </button>
            <div className="min-w-0 flex-1 sm:flex-initial sm:min-w-0">
              <div className="text-sm font-semibold text-white tracking-tight">
                Workspace
              </div>
              <p className="text-[11px] text-slate-500 leading-snug hidden sm:block mt-0.5">
                Message the council · outputs on the right
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
              className="hidden sm:inline-flex text-xs font-medium rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-slate-300 hover:bg-white/[0.07] shrink-0"
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
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden gap-0 lg:gap-0 lg:p-4 lg:pt-3">
          {/* Messages */}
          <div className="flex-1 flex flex-col min-w-0 min-h-0 lg:rounded-2xl lg:border lg:border-white/[0.08] lg:bg-[#0c0e14]/50 lg:shadow-xl lg:shadow-black/20 overflow-hidden">
            <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.06] bg-[#0a0b10]/40">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-200">Conversation</div>
                {sessionId ? (
                  <div
                    className="text-[11px] text-slate-500 mt-0.5 truncate"
                    title={`${currentSessionTitle || 'Session'} · ${sessionId}`}
                  >
                    {currentSessionTitle || 'Untitled'}
                    {phase ? (
                      <span className="text-slate-600"> · {phase}</span>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-[11px] text-slate-500 mt-0.5">Pick or start a chat</div>
                )}
              </div>
              {processStepCount > 0 ? (
                <div
                  className="shrink-0 inline-flex rounded-lg border border-white/[0.08] bg-black/20 p-0.5"
                  role="group"
                  aria-label="What to show in the thread"
                >
                  <button
                    type="button"
                    onClick={() => setShowProcessDetail(false)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      !showProcessDetail
                        ? 'bg-white/10 text-white shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    Focus
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowProcessDetail(true)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      showProcessDetail
                        ? 'bg-white/10 text-white shadow-sm'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                    title="Show routing, research, and specialist steps"
                  >
                    All · {processStepCount}
                  </button>
                </div>
              ) : null}
            </div>
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto scroll-smooth scroll-pb-6 px-4 sm:px-5 py-5 space-y-4 [scrollbar-gutter:stable]"
            >
              {feed.length === 0 && !sessionId && (
                <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-transparent p-8 sm:p-10 text-center max-w-lg mx-auto">
                  <p className="text-lg font-semibold text-white tracking-tight">
                    Welcome
                  </p>
                  <p className="text-slate-400 text-sm mt-3 leading-relaxed max-w-sm mx-auto">
                    Start a chat, choose a model above, and describe what you need. Your thread stays
                    clean — turn <span className="text-slate-300">All</span> on to see routing and
                    research steps.
                  </p>
                  <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center text-sm text-slate-500">
                    <span className="rounded-lg bg-white/[0.04] px-3 py-2 border border-white/[0.06]">
                      1. New chat
                    </span>
                    <span className="rounded-lg bg-white/[0.04] px-3 py-2 border border-white/[0.06]">
                      2. Model + council
                    </span>
                    <span className="rounded-lg bg-white/[0.04] px-3 py-2 border border-white/[0.06]">
                      3. Send message
                    </span>
                  </div>
                </div>
              )}
              {feed.length === 0 && sessionId && (
                <p className="text-slate-500 text-sm text-center max-w-sm mx-auto leading-relaxed">
                  Send a message to continue, or choose another chat in the list.
                </p>
              )}
              {feed.map((f) => {
                if (f.lane === 'process' && !showProcessDetail) {
                  return null
                }
                if (f.lane === 'process') {
                  return (
                    <article
                      key={f.id}
                      className="flex gap-3 max-w-2xl mr-auto pl-1"
                      aria-label="Background step"
                    >
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${processDotClass(f.kind)}`}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1 rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                            Activity
                          </span>
                          <span className="text-[11px] text-slate-400 font-medium leading-snug">
                            {f.title}
                          </span>
                        </div>
                        {f.body && (
                          <div className="mt-1.5 text-[12px] leading-relaxed text-slate-500 [&_strong]:text-slate-400 [&_a]:text-cyan-400/90 [&_a]:underline-offset-2">
                            <MessageMarkdown text={f.body} size="message" />
                          </div>
                        )}
                      </div>
                    </article>
                  )
                }
                const isUser = f.title === 'You'
                const isErr = f.kind === 'err'
                return (
                  <article
                    key={f.id}
                    className={`${isUser ? '' : 'mr-auto'} px-4 py-3 ${feedItemShell(f.kind, isUser, isErr)}`}
                  >
                    <div
                      className={`mb-1.5 ${feedTitleClass(
                        f.kind,
                        isUser,
                        isErr
                      )}`}
                    >
                      {f.title}
                    </div>
                    {f.body && (
                      <div
                        className={`text-[15px] leading-relaxed text-slate-100/95 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ${
                          isUser
                            ? '[&_a]:text-violet-200 [&_a]:decoration-violet-300/50'
                            : '[&_a]:text-violet-400/95'
                        }`}
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
              {!showProcessDetail && processStepCount > 0 && (
                <p className="text-center text-[11px] text-slate-500 py-2 rounded-xl bg-white/[0.02] border border-dashed border-white/[0.06]">
                  {processStepCount} step{processStepCount === 1 ? '' : 's'} in the background ·{' '}
                  <button
                    type="button"
                    className="text-violet-400 font-medium hover:text-violet-300"
                    onClick={() => setShowProcessDetail(true)}
                  >
                    Show activity
                  </button>
                </p>
              )}
              {busy && (
                <div
                  className="mr-auto max-w-sm rounded-2xl border border-violet-500/20 bg-violet-500/[0.08] px-4 py-3 text-sm text-violet-100/95 flex items-center gap-3"
                  role="status"
                  aria-live="polite"
                >
                  <span className="flex gap-1" aria-hidden>
                    <span className="size-2 rounded-full bg-violet-400 animate-bounce [animation-delay:-0.2s]" />
                    <span className="size-2 rounded-full bg-violet-400 animate-bounce" />
                    <span className="size-2 rounded-full bg-violet-400 animate-bounce [animation-delay:0.2s]" />
                  </span>
                  <span>Working on your request…</span>
                </div>
              )}
            </div>

            <div className="shrink-0 p-4 border-t border-white/[0.06] bg-[#08090c]/60 backdrop-blur-sm">
              <div className="max-w-3xl mx-auto flex gap-3 items-end">
                <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                  <textarea
                    ref={composerRef}
                    className={`w-full min-h-[52px] max-h-40 rounded-2xl border bg-[#12141c] px-4 py-3 text-[15px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/35 focus:border-violet-500/30 disabled:opacity-50 resize-y ${
                      awaiting
                        ? 'border-amber-500/40 ring-1 ring-amber-500/10'
                        : 'border-white/[0.08]'
                    }`}
                    placeholder={
                      awaiting
                        ? 'Answer the council’s question…'
                        : 'Message the council…'
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
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 px-1">
                    <span>
                      <kbd className="kbd-hint">Enter</kbd> send ·{' '}
                      <kbd className="kbd-hint">Shift+Enter</kbd> line
                    </span>
                    {busy && (
                      <button
                        type="button"
                        onClick={stopStream}
                        className="text-amber-200/90 hover:text-amber-100 font-medium"
                      >
                        Stop run
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onSend()}
                  disabled={busy || !input.trim() || !model}
                  title="Send"
                  className="shrink-0 h-12 w-12 sm:h-[3.25rem] sm:w-[3.25rem] rounded-2xl bg-violet-600 hover:bg-violet-500 disabled:opacity-35 disabled:hover:bg-violet-600 flex items-center justify-center text-white shadow-lg shadow-violet-950/25 transition active:scale-[0.97] motion-reduce:transform-none"
                >
                  <svg className="w-5 h-5 -translate-x-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12H12m0 0h7.5"
                    />
                  </svg>
                  <span className="sr-only">Send</span>
                </button>
              </div>
            </div>
          </div>

          {/* Plan + research panel */}
          <div
            className="w-full lg:w-[min(100%,22rem)] xl:w-[24rem] shrink-0 flex flex-col min-h-0 max-h-[min(42dvh,22rem)] lg:max-h-none lg:rounded-2xl lg:border lg:border-white/[0.08] lg:bg-[#0c0e14]/50 lg:shadow-xl lg:shadow-black/20 border-t lg:border-t-0 lg:ml-1 overflow-hidden"
            role="complementary"
            aria-label="Research and plan"
          >
            <div className="shrink-0 px-4 pt-4 pb-2 border-b border-white/[0.06]">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Outputs
              </h2>
              <p className="text-[11px] text-slate-600 mt-1">Research brief &amp; plan file</p>
            </div>
            <div
              className="shrink-0 flex p-2 gap-1"
              role="tablist"
              aria-label="Output panel"
            >
              <button
                type="button"
                role="tab"
                id="tab-research"
                aria-selected={rightPanelTab === 'research'}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-medium transition-colors ${
                  rightPanelTab === 'research'
                    ? 'text-white bg-violet-600/25 ring-1 ring-violet-500/35'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
                }`}
                onClick={() => setRightPanelTab('research')}
              >
                Research
                {research && (
                  <span
                    className="inline-flex size-1.5 rounded-full bg-emerald-400"
                    title="Has content"
                  />
                )}
              </button>
              <button
                type="button"
                role="tab"
                id="tab-plan"
                aria-selected={rightPanelTab === 'plan'}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-xs font-medium transition-colors ${
                  rightPanelTab === 'plan'
                    ? 'text-white bg-violet-600/25 ring-1 ring-violet-500/35'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04]'
                }`}
                onClick={() => setRightPanelTab('plan')}
              >
                Plan
                {planMd && (
                  <span
                    className="inline-flex size-1.5 rounded-full bg-violet-400"
                    title="Has content"
                  />
                )}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <div
                className={rightPanelTab === 'research' ? 'block' : 'hidden'}
                role="tabpanel"
                aria-labelledby="tab-research"
              >
                {research ? (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                        Sources
                      </h3>
                      <ul className="mt-2 text-xs text-slate-400 space-y-2 max-h-32 overflow-y-auto">
                        {research.sources?.slice(0, 12).map((s) => (
                          <li key={s.href}>
                            <a
                              href={s.href}
                              target="_blank"
                              rel="noreferrer"
                              className="text-violet-300/90 hover:text-violet-200 line-clamp-2 leading-snug"
                            >
                              {s.title || s.href}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-slate-200/95">
                      <MessageMarkdown text={research.brief} size="panel" />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-6 text-center">
                    <p className="text-sm text-slate-500 leading-relaxed">
                      No research yet. The orchestrator runs web search when it chooses to.
                    </p>
                  </div>
                )}
              </div>
              <div
                className={rightPanelTab === 'plan' ? 'block' : 'hidden'}
                role="tabpanel"
                aria-labelledby="tab-plan"
              >
                <div className="flex justify-between items-center gap-2 mb-3">
                  <h3 className="text-sm font-medium text-slate-200">plan.md</h3>
                  {planMd && (
                    <button
                      type="button"
                      onClick={downloadPlan}
                      className="text-xs font-medium rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-white"
                    >
                      Download
                    </button>
                  )}
                </div>
                {planMd ? (
                  <div
                    ref={planPreviewRef}
                    className="max-h-[min(36dvh,16rem)] lg:max-h-[min(60vh,28rem)] overflow-y-auto rounded-xl border border-white/[0.08] bg-black/25 p-3 select-text cursor-text"
                  >
                    <MessageMarkdown text={planMd} size="panel" />
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.02] px-4 py-6 text-center">
                    <p className="text-sm text-slate-500 leading-relaxed">
                      Plan appears here when the run reaches the planning step.
                    </p>
                  </div>
                )}
                {planMd.trim() && phase === 'done' && sessionId && (
                  <div className="mt-4 rounded-xl border border-violet-500/20 bg-violet-950/15 p-3 sm:p-4 space-y-3">
                    <div>
                      <h4 className="text-xs font-semibold text-violet-200/95 uppercase tracking-wide">
                        Refine with LLM
                      </h4>
                      <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                        Select text in the preview above (optional), capture it, then describe changes.
                        Choose which council personas supply the system prompt — their instructions are
                        merged for this edit only.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={capturePlanSelection}
                        className="text-xs font-medium rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-slate-200 hover:bg-white/[0.07]"
                      >
                        Capture selection
                      </button>
                      {refineSelection.trim() ? (
                        <span className="text-[10px] text-emerald-400/90 self-center">
                          Excerpt captured ({refineSelection.trim().length} chars)
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-500 self-center">
                          No excerpt — whole plan is in context
                        </span>
                      )}
                    </div>
                    <label className="block text-[11px] text-slate-400">
                      Excerpt (edit or paste)
                      <textarea
                        className="mt-1 w-full rounded-lg border border-slate-600/60 bg-slate-950/80 px-2 py-1.5 text-xs text-slate-100 font-mono min-h-[4rem] focus:outline-none focus:ring-1 focus:ring-violet-500/40"
                        value={refineSelection}
                        onChange={(e) => setRefineSelection(e.target.value)}
                        spellCheck={false}
                        placeholder="Optional — leave empty to refine the full document from your instruction alone."
                      />
                    </label>
                    <label className="block text-[11px] text-slate-400">
                      Instruction
                      <textarea
                        className="mt-1 w-full rounded-lg border border-slate-600/60 bg-slate-950/80 px-2 py-1.5 text-sm text-slate-100 min-h-[5rem] focus:outline-none focus:ring-1 focus:ring-violet-500/40"
                        value={refineInstruction}
                        onChange={(e) => setRefineInstruction(e.target.value)}
                        placeholder="e.g. Tighten the testing section, add Redis to the stack table, remove the mermaid diagram under Key flows."
                      />
                    </label>
                    {councilDetail ? (
                      <fieldset className="space-y-2">
                        <legend className="text-[11px] text-slate-500">Personas (system prompts)</legend>
                        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300">
                          {councilDetail.orchestrator ? (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                className="rounded border-slate-600"
                                checked={refineAgentIds.includes(councilDetail.orchestrator.id)}
                                onChange={() =>
                                  toggleRefineAgent(councilDetail.orchestrator!.id)
                                }
                              />
                              {councilDetail.orchestrator.name}
                              <span className="text-slate-500 font-mono text-[10px]">
                                {councilDetail.orchestrator.id}
                              </span>
                            </label>
                          ) : null}
                          {councilDetail.debating_agents.map((ag) => (
                            <label
                              key={ag.id}
                              className="flex items-center gap-2 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                className="rounded border-slate-600"
                                checked={refineAgentIds.includes(ag.id)}
                                onChange={() => toggleRefineAgent(ag.id)}
                              />
                              {ag.name}
                              <span className="text-slate-500 font-mono text-[10px]">{ag.id}</span>
                            </label>
                          ))}
                          {councilDetail.synthesizer ? (
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                className="rounded border-slate-600"
                                checked={refineAgentIds.includes(councilDetail.synthesizer.id)}
                                onChange={() =>
                                  toggleRefineAgent(councilDetail.synthesizer!.id)
                                }
                              />
                              {councilDetail.synthesizer.name}
                              <span className="text-slate-500 font-mono text-[10px]">
                                {councilDetail.synthesizer.id}
                              </span>
                            </label>
                          ) : null}
                        </div>
                      </fieldset>
                    ) : (
                      <p className="text-[11px] text-slate-500">Loading council roster…</p>
                    )}
                    <button
                      type="button"
                      disabled={busy || !refineInstruction.trim()}
                      onClick={() => void onRefinePlan()}
                      className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2 text-sm font-medium text-white"
                    >
                      {busy ? 'Working…' : 'Apply refinement'}
                    </button>
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
