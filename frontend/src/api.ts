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
}

export type ModelsResponse = {
  models: string[]
  default?: string
  provider?: string
  hint?: string
  ollama?: OllamaProbe | { reachable: boolean; model_count: number; base_url?: string }
}

export type SessionResponse = {
  id: string
  model: string
  phase: string
  pending_user_questions?: string[]
  plan_markdown?: string
  plan_filename?: string
  messages?: Array<{
    role: string
    content: string
    agent_id?: string | null
    agent_name?: string | null
    meta?: Record<string, unknown>
  }>
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
  | { type: 'synth'; summary: string }
  | { type: 'plan'; content: string; filename: string }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'stream_end' }
  | Record<string, unknown>

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

export async function createSession(model: string): Promise<SessionResponse> {
  const r = await fetch(`${API}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
  if (!r.ok) throw new Error((await r.text()) || 'create session')
  return r.json()
}

export async function getSession(
  sessionId: string
): Promise<SessionResponse> {
  const r = await fetch(`${API}/sessions/${sessionId}`)
  if (!r.ok) throw new Error(`session: ${r.status}`)
  return r.json()
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
