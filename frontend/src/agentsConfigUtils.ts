import type { AgentDef, CouncilConfig } from './api'

const DEFAULT_SYNTH: AgentDef = {
  id: 'synthesizer',
  name: 'Synthesizer',
  title: 'Alignment',
  system_prompt: '',
  tools_enabled: false,
}

export function defaultSynthesizer(): AgentDef {
  return { ...DEFAULT_SYNTH }
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
  if (!id) return null
  return {
    id,
    name: nameRaw || id,
    title,
    system_prompt,
    tools_enabled,
  }
}

/**
 * Import council config from JSON (file or API). Tolerates minor shape issues; rejects empty debate list.
 */
export function parseCouncilConfigJson(data: unknown): CouncilConfig | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  if (!Array.isArray(o.debating_agents) || o.debating_agents.length < 1) return null

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

  let synthesizer: AgentDef | null = null
  if (o.synthesizer != null && typeof o.synthesizer === 'object') {
    const s = normalizeAgentFromJson(
      o.synthesizer as Record<string, unknown>,
      DEFAULT_SYNTH.id
    )
    if (s) synthesizer = s
  }

  return {
    debating_agents: debaters,
    synthesizer: synthesizer ?? { ...DEFAULT_SYNTH },
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
  return JSON.stringify(
    { debating_agents: c.debating_agents, synthesizer: c.synthesizer },
    null,
    2
  )
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
