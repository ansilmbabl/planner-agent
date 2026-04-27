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
  research?: {
    provider: string
    tavily_ready: boolean
  }
}

export type PreferencesResponse = {
  research_provider: 'duckduckgo' | 'tavily'
  tavily_key_stored: boolean
  tavily_key_from_env: boolean
}

export type ModelsResponse = {
  models: string[]
  default?: string
  provider?: string
  hint?: string
  ollama?: OllamaProbe | { reachable: boolean; model_count: number; base_url?: string }
}

export type PlanVersion = {
  filename: string
  markdown: string
  created_ts: number
  source: string
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

export type OutputMode = 'plan' | 'report' | 'code' | 'conversation' | 'none'

export type ReferenceUrl = {
  url: string
  label?: string
  placement: 'session_start' | 'after_research' | 'before_artifact'
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
  /** plan | report | code | conversation | none */
  artifact_kind?: string
  /** Per-chat URLs merged into the research brief (see Research tab in the app). */
  reference_urls?: ReferenceUrl[]
  plan_versions?: PlanVersion[]
  plan_iteration_message?: string
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
      /** Specialists to run in parallel this step (empty for non-call actions). */
      agent_ids?: string[]
      agent_id?: string | null
      step?: number
      /** Maps agent id → display name for this council (routing activity). */
      agent_labels?: Record<string, string>
    }
  | { type: 'synth'; summary: string }
  | { type: 'orchestrator_reply'; content: string }
  | {
      type: 'plan_snapshot'
      plan_markdown?: string
      plan_filename?: string
      plan_versions?: PlanVersion[]
    }
  | {
      type: 'plan'
      content: string
      filename: string
      plan_versions?: PlanVersion[]
      artifact_kind?: string
    }
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
  /**
   * Orchestrator hint only (default true): when true, lean toward run_research when grounding helps;
   * when false, use run_research only when clearly needed. No steps run before the first orchestrator decision.
   */
  initial_research?: boolean
  /** When null/omitted, the API uses a built-in routing prompt. */
  orchestrator?: AgentDef | null
  /**
   * Routing guidelines injected into the orchestrator user message.
   * Empty/omitted → server uses backend/app/prompts/orchestrator.py defaults.
   */
  orchestrator_user_instructions?: string | null
  /** Primary artifact after the council run (default plan). */
  output_mode?: OutputMode
  /** Extra instructions for report/code generation. */
  output_instructions?: string | null
  /** Download filename hint for report or code. */
  artifact_filename?: string | null
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
  const noneTemplate =
    fromId === 'none' || fromId === '' || fromId === '__none__'
  const r = await fetch(`${API}/councils`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: newId.trim(),
      from_id: noneTemplate ? 'none' : fromId,
    }),
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

export async function patchSession(
  sessionId: string,
  body: { council_id?: string; reference_urls?: ReferenceUrl[] }
): Promise<{
  id: string
  council_id: string
  reference_urls?: ReferenceUrl[]
}> {
  const r = await fetch(`${API}/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `patch session: ${r.status}`)
  }
  return r.json()
}

export async function deleteSessionApi(sessionId: string): Promise<void> {
  const r = await fetch(`${API}/sessions/${sessionId}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`delete: ${r.status}`)
}

export async function bulkDeleteSessions(
  ids: string[]
): Promise<{ deleted: number; missing: string[] }> {
  const r = await fetch(`${API}/sessions/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `bulk-delete: ${r.status}`)
  }
  return r.json() as Promise<{ deleted: number; missing: string[] }>
}

export async function getPreferences(): Promise<PreferencesResponse> {
  const r = await fetch(`${API}/preferences`)
  if (!r.ok) throw new Error(`preferences: ${r.status}`)
  return r.json()
}

export async function putPreferences(body: {
  research_provider?: 'duckduckgo' | 'tavily'
  tavily_api_key?: string
}): Promise<PreferencesResponse> {
  const r = await fetch(`${API}/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `preferences: ${r.status}`)
  }
  return r.json()
}

export type BuiltinPromptItem = {
  key: string
  category: string
  title: string
  description: string
  content: string
  is_default: boolean
}

export async function getBuiltinPrompts(): Promise<BuiltinPromptItem[]> {
  const r = await fetch(`${API}/builtin-prompts`)
  if (!r.ok) throw new Error(`builtin-prompts: ${r.status}`)
  const j = (await r.json()) as { prompts?: BuiltinPromptItem[] }
  return j.prompts ?? []
}

export async function putBuiltinPrompt(
  key: string,
  content: string
): Promise<{ status: string; key: string }> {
  const r = await fetch(`${API}/builtin-prompts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, content }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `builtin-prompts: ${r.status}`)
  }
  return r.json()
}

export async function resetBuiltinPrompts(): Promise<{
  status: string
  prompts: BuiltinPromptItem[]
}> {
  const r = await fetch(`${API}/builtin-prompts/reset`, { method: 'POST' })
  if (!r.ok) throw new Error(`builtin-prompts reset: ${r.status}`)
  return r.json()
}

export async function refinePromptText(body: {
  current_prompt: string
  instruction: string
  context_label?: string
  model?: string
}): Promise<{ refined: string; model: string }> {
  const r = await fetch(`${API}/refine-prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `refine-prompt: ${r.status}`)
  }
  return r.json() as Promise<{ refined: string; model: string }>
}

export type RefinePlanPayload = {
  instruction: string
  selection?: string
  agent_ids?: string[]
  model?: string
}

export async function* streamRefinePlan(
  sessionId: string,
  body: RefinePlanPayload,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, unknown> {
  const r = await fetch(
    `${API}/sessions/${encodeURIComponent(sessionId)}/refine-plan`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: body.instruction,
        ...(body.selection?.trim()
          ? { selection: body.selection.trim() }
          : {}),
        ...(body.agent_ids?.length ? { agent_ids: body.agent_ids } : {}),
        ...(body.model?.trim() ? { model: body.model.trim() } : {}),
      }),
      signal,
    }
  )
  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || `HTTP ${r.status}`)
  }
  const bodyStream = r.body
  if (!bodyStream) {
    return
  }
  const reader = bodyStream.getReader()
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

export async function* streamUserMessage(
  sessionId: string,
  content: string,
  model: string,
  signal?: AbortSignal,
  opts?: { intent?: 'new_run' | 'continue_plan' }
): AsyncGenerator<SseEvent, void, unknown> {
  const r = await fetch(`${API}/sessions/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      model,
      intent: opts?.intent ?? 'new_run',
    }),
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
