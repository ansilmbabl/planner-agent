import type { AgentDef, CouncilConfig, OutputMode } from './api'

/** Matches backend default when council has no orchestrator object. */
export const DEFAULT_ORCHESTRATOR_AGENT: AgentDef = {
  id: 'orchestrator',
  name: 'Orchestrator',
  title: 'Routing and flow',
  system_prompt:
    'You are the Council Orchestrator. Choose exactly ONE next step: research, calling agents by id, asking the user, replying yourself, requesting the configured primary output, or ending. Route only; do not role-play as a council agent.',
  tools_enabled: false,
  tool_ids: [],
}

function normalizeToolIdsList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const s = x.trim()
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= 24) break
  }
  return out
}

/** Whether the graph / badges should show a tools chip (server registry ids). */
export function agentHasEffectiveTools(
  agent: AgentDef,
  registeredIds: string[]
): boolean {
  if (!agent.tools_enabled) return false
  if (!registeredIds.length) return true
  const raw = agent.tool_ids ?? []
  if (raw.length === 0) return true
  return raw.some((id) => registeredIds.includes(id))
}

function normalizeAgentFields(a: AgentDef): AgentDef {
  return { ...a, tool_ids: normalizeToolIdsList(a.tool_ids) }
}

/** Normalize optional council fields so the settings UI always has orchestrator + instructions string. */
export function mergeCouncilDefaults(c: CouncilConfig): CouncilConfig {
  const om: OutputMode =
    c.output_mode &&
    ['plan', 'report', 'code', 'conversation', 'none'].includes(c.output_mode)
      ? c.output_mode
      : 'plan'
  const tags = Array.isArray(c.tags)
    ? c.tags.map((t) => (typeof t === 'string' ? t.trim() : '')).filter(Boolean).slice(0, 48)
    : []
  const orch = normalizeAgentFields(c.orchestrator ?? DEFAULT_ORCHESTRATOR_AGENT)
  return {
    ...c,
    initial_research: c.initial_research !== false,
    orchestrator: orch,
    orchestrator_user_instructions: c.orchestrator_user_instructions ?? '',
    output_mode: om,
    output_instructions: c.output_instructions ?? '',
    artifact_filename: c.artifact_filename ?? '',
    display_name: c.display_name ?? '',
    notes: c.notes ?? '',
    tags,
    area: c.area ?? '',
    debating_agents: (c.debating_agents ?? []).map(normalizeAgentFields),
  }
}

function normalizeAgentFromJson(
  row: Record<string, unknown>,
  fallbackId: string
): AgentDef | null {
  const id =
    typeof row.id === 'string' && row.id.trim() ? row.id.trim() : fallbackId
  const nameRaw = typeof row.name === 'string' ? row.name.trim() : ''
  const title = typeof row.title === 'string' ? row.title : ''
  const system_prompt =
    typeof row.system_prompt === 'string' ? row.system_prompt : ''
  const tools_enabled = Boolean(row.tools_enabled)
  const tool_ids = normalizeToolIdsList(row.tool_ids)
  if (!id) return null
  return {
    id,
    name: nameRaw || id,
    title,
    system_prompt,
    tools_enabled,
    tool_ids,
  }
}

/**
 * Import council config from JSON (file or API). Tolerates minor shape issues; allows zero debaters (orchestrator-only starter).
 */
export function parseCouncilConfigJson(data: unknown): CouncilConfig | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  if (!Array.isArray(o.debating_agents)) return null

  const debaters: AgentDef[] = []
  const usedIds = new Set<string>()

  for (let i = 0; i < o.debating_agents.length; i++) {
    const el = o.debating_agents[i]
    if (!el || typeof el !== 'object') return null
    const row = el as Record<string, unknown>
    const fallbackId = `imported_${i}`
    const a = normalizeAgentFromJson(row, fallbackId)
    if (!a) return null
    if (usedIds.has(a.id)) return null
    usedIds.add(a.id)
    debaters.push(a)
  }

  if (o.synthesizer != null && typeof o.synthesizer === 'object') {
    const s = normalizeAgentFromJson(
      o.synthesizer as Record<string, unknown>,
      'synthesizer'
    )
    if (s && !usedIds.has(s.id)) {
      usedIds.add(s.id)
      debaters.push(s)
    }
  }

  let orchestrator: AgentDef | null = null
  if (o.orchestrator != null && typeof o.orchestrator === 'object') {
    const oc = normalizeAgentFromJson(
      o.orchestrator as Record<string, unknown>,
      'orchestrator'
    )
    if (oc) orchestrator = oc
  }

  let orchestrator_user_instructions: string | undefined
  if (typeof o.orchestrator_user_instructions === 'string') {
    orchestrator_user_instructions = o.orchestrator_user_instructions
  }

  let initial_research: boolean | undefined
  if (typeof o.initial_research === 'boolean') {
    initial_research = o.initial_research
  }

  let output_mode: OutputMode | undefined
  if (
    typeof o.output_mode === 'string' &&
    ['plan', 'report', 'code', 'conversation', 'none'].includes(o.output_mode)
  ) {
    output_mode = o.output_mode as OutputMode
  }

  let output_instructions: string | undefined
  if (typeof o.output_instructions === 'string') {
    output_instructions = o.output_instructions
  }

  let artifact_filename: string | undefined
  if (typeof o.artifact_filename === 'string') {
    artifact_filename = o.artifact_filename
  }

  let display_name: string | undefined
  if (typeof o.display_name === 'string') {
    display_name = o.display_name
  }

  let notes: string | undefined
  if (typeof o.notes === 'string') {
    notes = o.notes
  }

  let tags: string[] | undefined
  if (Array.isArray(o.tags)) {
    const tgs: string[] = []
    for (const x of o.tags) {
      if (typeof x !== 'string') continue
      const s = x.trim()
      if (s) tgs.push(s.slice(0, 80))
      if (tgs.length >= 48) break
    }
    tags = tgs
  }

  let area: string | undefined
  if (typeof o.area === 'string') {
    area = o.area
  }

  return {
    debating_agents: debaters,
    ...(orchestrator ? { orchestrator } : {}),
    ...(orchestrator_user_instructions !== undefined
      ? { orchestrator_user_instructions }
      : {}),
    ...(initial_research !== undefined ? { initial_research } : {}),
    ...(output_mode !== undefined ? { output_mode } : {}),
    ...(output_instructions !== undefined ? { output_instructions } : {}),
    ...(artifact_filename !== undefined ? { artifact_filename } : {}),
    ...(display_name !== undefined ? { display_name } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(area !== undefined ? { area } : {}),
  }
}

export function parseCouncilConfigText(text: string): CouncilConfig | null {
  try {
    return parseCouncilConfigJson(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

export function councilConfigToJsonString(c: CouncilConfig): string {
  const o: Record<string, unknown> = {}
  if (c.initial_research === false) {
    o.initial_research = false
  }
  if (c.orchestrator) o.orchestrator = c.orchestrator
  if (c.orchestrator_user_instructions?.trim()) {
    o.orchestrator_user_instructions = c.orchestrator_user_instructions.trim()
  }
  const om = c.output_mode ?? 'plan'
  if (om !== 'plan') {
    o.output_mode = om
  }
  if (c.output_instructions?.trim()) {
    o.output_instructions = c.output_instructions.trim()
  }
  if (c.artifact_filename?.trim()) {
    o.artifact_filename = c.artifact_filename.trim()
  }
  if (c.display_name?.trim()) {
    o.display_name = c.display_name.trim()
  }
  if (c.notes?.trim()) {
    o.notes = c.notes.trim()
  }
  if (c.tags?.length) {
    o.tags = c.tags
  }
  if (c.area?.trim()) {
    o.area = c.area.trim()
  }
  o.debating_agents = c.debating_agents
  return JSON.stringify(o, null, 2)
}

export function configSignature(c: CouncilConfig): string {
  return councilConfigToJsonString(c)
}

export function uniqueNewAgentId(
  existingIds: Set<string>,
  preferredRoot = 'agent'
): string {
  const root = preferredRoot.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_|_$/g, '') || 'agent'
  const base = `${root}_${Date.now().toString(36)}`
  if (!existingIds.has(base) && base.length < 200) return base
  for (let n = 2; n < 5000; n++) {
    const id = `${base}_${n}`
    if (!existingIds.has(id) && id.length < 200) return id
  }
  return `agent_${Math.random().toString(36).slice(2, 11)}`
}

/**
 * URL-safe id from a display name (used in council JSON and orchestrator routing).
 * `exceptId` may stay taken by this agent while picking a new slug (rename flow).
 */
export function slugAgentId(
  name: string,
  taken: Set<string>,
  exceptId?: string
): string {
  let base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  if (!base) base = 'agent'
  const blocked = (id: string) => id !== exceptId && taken.has(id)
  let cand = base
  for (let n = 2; blocked(cand) && n < 10_000; n++) {
    cand = `${base}_${n}`
  }
  if (!blocked(cand)) return cand
  return uniqueNewAgentId(taken, base)
}
