import { useCallback, useEffect, useState } from 'react'
import { refinePromptText } from '../api'

function stripOuterFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```(?:\w+)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/)
  if (m) return m[1]!.trim()
  return t
}

type PromptRefineWidgetProps = {
  /** What this block is (shown to the model). */
  contextLabel: string
  currentText: string
  models: string[]
  defaultModel: string
  onApply: (refined: string) => void
  compact?: boolean
}

export function PromptRefineWidget({
  contextLabel,
  currentText,
  models,
  defaultModel,
  onApply,
  compact,
}: PromptRefineWidgetProps) {
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [model, setModel] = useState(defaultModel)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    setModel(defaultModel)
  }, [defaultModel])

  const run = useCallback(async () => {
    setBusy(true)
    setErr(null)
    setPreview(null)
    try {
      const m = (model || defaultModel || '').trim() || undefined
      const ins = instruction.trim()
      const { refined } = await refinePromptText({
        current_prompt: currentText,
        ...(ins ? { instruction: ins } : {}),
        context_label: contextLabel,
        model: m,
      })
      setPreview(stripOuterFence(refined))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Refine failed')
    } finally {
      setBusy(false)
    }
  }, [contextLabel, currentText, defaultModel, instruction, model])

  if (!models.length) {
    return (
      <p className="text-[10px] text-slate-500 rounded-lg border border-dashed border-white/10 px-2 py-1.5">
        Load models under <span className="text-slate-400">Connection</span> to refine prompts with the LLM.
      </p>
    )
  }

  return (
    <div
      className={`rounded-lg border border-white/[0.06] bg-black/20 ${compact ? 'p-2' : 'p-2.5'} space-y-2`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-medium text-cyan-400/95 hover:text-cyan-300"
      >
        {open ? '▼' : '▶'} Refine with model
      </button>
      {open && (
        <div className="space-y-2 pt-0.5">
          <label className="block text-[10px] text-slate-500">
            Tweaks (optional — leave empty for a general polish)
            <textarea
              className="mt-1 w-full rounded-md border border-slate-600/60 bg-slate-950/80 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/35 min-h-[4rem]"
              placeholder="Empty = tighten & clarify while keeping intent. Or add specifics: shorter, stronger security, add JSON example…"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[10px] text-slate-500 min-w-[8rem] flex-1">
              Model
              <select
                className="mt-0.5 w-full rounded-md border border-slate-600/60 bg-slate-950/80 px-2 py-1 text-xs text-slate-100"
                value={model || defaultModel}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run()}
              className="text-xs font-medium rounded-lg bg-cyan-600/90 hover:bg-cyan-500 disabled:opacity-40 px-2.5 py-1.5 text-white shrink-0"
            >
              {busy ? 'Running…' : 'Generate'}
            </button>
          </div>
          {err && (
            <p className="text-[11px] text-amber-200/90">{err}</p>
          )}
          {preview != null && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-slate-500">Preview</div>
              <pre className="max-h-40 overflow-auto rounded-md border border-slate-600/40 bg-slate-950/90 p-2 text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                {preview}
              </pre>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onApply(preview)
                    setPreview(null)
                    setInstruction('')
                  }}
                  className="text-xs font-medium rounded-lg bg-emerald-600/85 hover:bg-emerald-500 px-2.5 py-1 text-white"
                >
                  Apply to field
                </button>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  Discard preview
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
