const API = '/api'

export type OllamaProbe = {
  reachable: boolean
  base_url: string
  model_count: number
  models?: string[]
  error: string | null
}

export type HealthResponse = {
  status: string
  service?: string
  llm_provider?: string
  ollama?: OllamaProbe
  /** e.g. "sqlite" — session storage backend */
  persistence?: string
}

export type ModelsResponse = {
  models: string[]
  default?: string
  provider?: string
  hint?: string
  ollama?: OllamaProbe | { reachable: boolean; model_count: number; base_url?: string }
}

export type SessionMessage = {
  role: string
  content: string
  agent_id?: string | null
  agent_name?: string | null
  meta?: Record<string, unknown>
}

export type SessionListItem = {
  id: string
  title: string
  model: string
  /** config/councils/{council_id}.json used for this chat */
  council_id?: string
  phase: string
  created_ts: number
  updated_ts: number
  has_plan: boolean
}

export type SessionResponse = {
  id: string
  title?: string
  model: string
  council_id?: string
  phase: string
  created_ts?: number
  updated_ts?: number
  user_brief?: string
  research_brief?: string
  research_sources?: { title: string; href: string; body?: string }[]
  pending_user_questions?: string[]
  plan_markdown?: string
  plan_filename?: string
  error_message?: string | null
  messages?: SessionMessage[]
}

export type SseEvent =
  | { type: 'phase'; phase: string; round?: number; message?: string }
  | {
      type: 'research'
      brief: string
      sources: { title: string; href: string; body: string }[]
    }
  | {
      type: 'agent'
      round: number
      agent_id: string
      name: string
      reaction: string
      planner_note: string
      user_question?: string | null
    }
  | { type: 'awaiting_user'; questions: string[] }
  | {
      type: 'orchestrator'
      action: string
      reason?: string
      agent_id?: string | null
      step?: number
    }
  | { type: 'synth'; summary: string }
  | { type: 'plan'; content: string; filename: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'stream_end' }
  | Record<string, unknown>

export type AgentDef = {
  id: string
  name: string
  title: string
  system_prompt: string
  tools_enabled: boolean
}

export type CouncilConfig = {
  debating_agents: AgentDef[]
  synthesizer: AgentDef | null
  /** When null/omitted, the API uses a built-in routing prompt. */
  orchestrator?: AgentDef | null
  /**
   * Routing guidelines injected into the orchestrator user message.
   * Empty/omitted → server uses backend/app/prompts/orchestrator.py defaults.
   */
  orchestrator_user_instructions?: string | null
}

export async function listCouncils(): Promise<string[]> {
  const r = await fetch(`${API}/councils`)
  if (!r.ok) throw new Error(`councils: ${r.status}`)
  const j = (await r.json()) as { councils?: string[] }
  return j.councils ?? []
}

export async function createCouncil(
  newId: string,
  fromId: string = 'default'
): Promise<{ status: string; id: string; path: string }> {
  const r = await fetch(`${API}/councils`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: newId.trim(), from_id: fromId }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `create council: ${r.status}`)
  }
  return r.json()
}

export async function deleteCouncil(
  councilId: string
): Promise<{ status: string; id: string }> {
  const r = await fetch(
    `${API}/councils/${encodeURIComponent(councilId)}`,
    { method: 'DELETE' }
  )
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `delete council: ${r.status}`)
  }
  return r.json()
}

export async function getCouncil(councilId: string = 'default'): Promise<CouncilConfig> {
  const r = await fetch(
    `${API}/councils/${encodeURIComponent(councilId)}`
  )
  if (!r.ok) throw new Error(`council: ${r.status}`)
  return r.json()
}

export async function putCouncil(
  config: CouncilConfig,
  councilId: string = 'default'
): Promise<{ status: string; path?: string; id?: string }> {
  const r = await fetch(
    `${API}/councils/${encodeURIComponent(councilId)}`,
    {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `council save: ${r.status}`)
  }
  return r.json()
}

export async function getHealth(): Promise<HealthResponse> {
  const r = await fetch(`${API}/health`)
  if (!r.ok) throw new Error(`health: ${r.status}`)
  return r.json()
}

export async function getModels(): Promise<ModelsResponse> {
  const r = await fetch(`${API}/models`)
  if (!r.ok) throw new Error(`models: ${r.status}`)
  return r.json()
}

export async function createSession(
  model: string,
  councilId: string = 'default'
): Promise<SessionResponse> {
  const r = await fetch(`${API}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, council_id: councilId }),
  })
  if (!r.ok) throw new Error((await r.text()) || 'create session')
  return r.json()
}

export async function listSessions(): Promise<SessionListItem[]> {
  const r = await fetch(`${API}/sessions`)
  if (!r.ok) throw new Error(`sessions: ${r.status}`)
  return r.json()
}

export async function getSession(
  sessionId: string
): Promise<SessionResponse> {
  const r = await fetch(`${API}/sessions/${sessionId}`)
  if (!r.ok) throw new Error(`session: ${r.status}`)
  return r.json()
}

export async function deleteSessionApi(sessionId: string): Promise<void> {
  const r = await fetch(`${API}/sessions/${sessionId}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`delete: ${r.status}`)
}

export async function* streamUserMessage(
  sessionId: string,
  content: string,
  model: string,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, unknown> {
  const r = await fetch(`${API}/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, model }),
    signal,
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `HTTP ${r.status}`)
  }
  const body = r.body
  if (!body) {
    return
  }
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const blocks = buf.split('\n\n')
    buf = blocks.pop() ?? ''
    for (const b of blocks) {
      if (!b.trim()) continue
      const m = b.match(/^data: (.+)$/ms)
      if (m) {
        try {
          const ev = JSON.parse(m[1]!) as SseEvent
          yield ev
        } catch {
          /* ignore */
        }
      }
    }
  }
}
