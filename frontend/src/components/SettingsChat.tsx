import { useCallback, useEffect, useRef, useState } from 'react'
import type { HealthResponse } from '../api'
import { MessageMarkdown } from './MessageMarkdown'

function simpleId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

type Turn = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

function replyForQuestion(q: string): string {
  const t = q.toLowerCase()
  if (/\b(ollama|host|url|local|connection|reachable)\b/.test(t)) {
    return (
      '**Ollama** is probed at the URL shown in the connection card. Start Ollama on the host, then hit **Refresh**. ' +
      'If the list is empty, run `ollama pull <model>` on that machine.'
    )
  }
  if (/\b(model|which|llm|gemma|llama|mistral)\b/.test(t)) {
    return (
      'Use the **Model** control for the default model on **new chats**. ' +
      'Some models are for images only — pick a **text** chat model for the council.'
    )
  }
  if (/\b(store|save|persist|sqlite|db|database|history)\b/.test(t)) {
    return (
      'Chat sessions are stored in a **SQLite database** on the API server (`data/planner.db` by default). ' +
      'Legacy JSON files under `data/sessions/` were imported once if they were not already in the database.'
    )
  }
  if (/\b(help|what|how)\b/.test(t)) {
    return (
      'Ask me about **Ollama**, **models**, or **where data is stored**. ' +
      'You can also use the controls above — they apply right away.'
    )
  }
  return (
    'I am a small settings helper (not the council). Try keywords like **Ollama**, **model**, or **storage**, ' +
    'or use the **Refresh** and model dropdown in the cards.'
  )
}

type SettingsChatProps = {
  health: HealthResponse | null
  modelHint: string | null
  ollamaHostReachable: boolean
  models: string[]
  model: string
  onModelChange: (v: string) => void
  onRefresh: () => void
  busy: boolean
  onBack: () => void
  onOpenSidebar?: () => void
}

export function SettingsChat({
  health,
  modelHint,
  ollamaHostReachable,
  models,
  model,
  onModelChange,
  onRefresh,
  busy,
  onBack,
  onOpenSidebar,
}: SettingsChatProps) {
  const [turns, setTurns] = useState<Turn[]>(() => [
    {
      id: 'intro',
      role: 'assistant',
      text:
        "Hi — I'm the **Settings** helper. I don't run the multi-agent council; I only help you wire up **Ollama** and the **default model**.\n\n" +
        'Use the cards below, or type a question at the bottom.',
    },
  ])
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const oll = health?.ollama
  const ollamaOk = oll?.reachable && (oll.model_count ?? 0) > 0

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [turns, scrollToBottom])

  const send = useCallback(() => {
    const t = input.trim()
    if (!t) return
    setInput('')
    setTurns((x) => [
      ...x,
      { id: simpleId(), role: 'user', text: t },
      { id: simpleId(), role: 'assistant', text: replyForQuestion(t) },
    ])
  }, [input])

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#0b0c0f]">
      <header className="shrink-0 border-b border-white/5 px-3 py-2 sm:px-4 flex items-center gap-3">
        {onOpenSidebar && (
          <button
            type="button"
            onClick={onOpenSidebar}
            className="sm:hidden rounded-lg border border-slate-600/60 px-2.5 py-1.5 text-xs text-slate-200"
          >
            Chats
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-violet-400 hover:underline"
        >
          ← Back to chats
        </button>
        <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto scroll-smooth px-3 sm:px-5 py-4 space-y-4 max-w-2xl mx-auto w-full"
      >
        {turns.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[min(100%,32rem)] rounded-2xl px-3.5 py-2.5 border ${
                m.role === 'user'
                  ? 'bg-violet-500/10 border-violet-500/20'
                  : 'bg-slate-800/50 border-slate-700/45'
              }`}
            >
              <div
                className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${
                  m.role === 'user' ? 'text-violet-300' : 'text-slate-500'
                }`}
              >
                {m.role === 'user' ? 'You' : 'Settings bot'}
              </div>
              <MessageMarkdown
                text={m.text}
                size="message"
                plain={false}
              />
            </div>
          </div>
        ))}

        {/* Control cards (assistant side) */}
        <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-4 space-y-3">
          <div className="text-[10px] font-semibold uppercase text-slate-500">
            Connection
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-200">
            <span
              className={`h-2 w-2 rounded-full shrink-0 ${
                ollamaOk
                  ? 'bg-emerald-500'
                  : oll?.reachable === false
                    ? 'bg-rose-500'
                    : 'bg-amber-500'
              }`}
              aria-hidden
            />
            <span className="text-slate-300">
              {!health
                ? 'Loading health…'
                : ollamaOk
                  ? `${oll?.model_count} models · ${oll?.base_url ?? ''}`
                  : oll?.reachable
                    ? `${oll?.model_count ?? 0} models · ${oll?.base_url ?? ''}`
                    : oll?.error || 'Ollama not reachable'}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              disabled={busy}
              className="ml-auto text-xs rounded-lg border border-violet-500/40 px-2.5 py-1.5 text-violet-200 hover:bg-violet-500/10 disabled:opacity-40"
            >
              Refresh
            </button>
          </div>
        </div>

        {ollamaHostReachable && (
          <div className="text-amber-200/90 text-xs rounded-xl border border-amber-500/20 bg-amber-950/25 px-3 py-2">
            No models listed — on the Ollama host run{' '}
            <code className="text-amber-100">ollama pull &lt;name&gt;</code> then
            **Refresh**.
          </div>
        )}

        {modelHint && (
          <div className="text-amber-200/95 text-xs rounded-xl border border-amber-500/25 bg-amber-950/25 px-3 py-2 flex flex-wrap gap-2 items-start justify-between">
            <span className="min-w-0 flex-1">{modelHint}</span>
          </div>
        )}

        <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-4 space-y-2">
          <div className="text-[10px] font-semibold uppercase text-slate-500">
            Default model
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            Used for **new chats** and when a session has no model yet.
          </p>
          <label className="block text-xs text-slate-400">
            <span className="sr-only">Model</span>
            <select
              className="mt-1 w-full max-w-md rounded-lg border border-slate-600/80 bg-slate-950/80 px-2 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-violet-500/40"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={busy}
            >
              {models.length === 0 && (
                <option value="" disabled>
                  No models
                </option>
              )}
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rounded-2xl border border-slate-700/40 bg-slate-950/30 px-3 py-2 text-[11px] text-slate-500 leading-relaxed">
          <span className="font-semibold text-slate-400">Storage: </span>
          Sessions are stored via the API (
          <code className="text-slate-400">{health?.persistence ?? 'sqlite'}</code>
          ). Default file is <code className="text-slate-400">data/planner.db</code>.
          Legacy JSON under <code className="text-slate-400">data/sessions/</code> is
          imported on the server on startup.
        </div>
      </div>

      <div className="shrink-0 border-t border-white/5 p-3 bg-[#0a0a0c]/90">
        <div className="max-w-2xl mx-auto flex flex-col gap-1">
          <div className="flex gap-2">
            <textarea
              className="flex-1 min-h-[44px] max-h-28 rounded-xl border border-slate-600/70 bg-slate-950/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500/35"
              placeholder="Ask about Ollama, models, or storage… (Enter to send)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              rows={2}
            />
            <button
              type="button"
              onClick={send}
              className="self-end rounded-xl bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white"
            >
              Send
            </button>
          </div>
          <p className="text-[10px] text-slate-600 px-0.5">
            This thread uses canned replies — the council has its own chat.
          </p>
        </div>
      </div>
    </div>
  )
}
