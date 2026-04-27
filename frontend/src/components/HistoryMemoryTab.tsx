import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  bulkDeleteSessions,
  getSession,
  listSessions,
  type SessionListItem,
  type SessionResponse,
} from '../api'

function escapeCsv(s: string) {
  const t = s ?? ''
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`
  return t
}

function downloadBlob(filename: string, content: string, mime: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type: mime }))
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export function HistoryMemoryTab({
  onBulkDeleted,
}: {
  onBulkDeleted?: (ids: string[]) => void
} = {}) {
  const [list, setList] = useState<SessionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const l = await listSessions()
      setList(l)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setList([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  const selectAll = () => {
    if (selected.size === list.length) setSelected(new Set())
    else setSelected(new Set(list.map((x) => x.id)))
  }

  const selectedItems = useMemo(
    () => list.filter((x) => selected.has(x.id)),
    [list, selected]
  )

  async function onDelete() {
    if (!selected.size) return
    if (
      !window.confirm(
        `Delete ${selected.size} chat(s)? This cannot be undone.`
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ids = [...selected]
      await bulkDeleteSessions(ids)
      onBulkDeleted?.(ids)
      setSelected(new Set())
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function exportJson() {
    if (!selectedItems.length) return
    setBusy(true)
    try {
      const full: SessionResponse[] = []
      for (const it of selectedItems) {
        try {
          full.push(await getSession(it.id))
        } catch {
          /* skip missing */
        }
      }
      downloadBlob(
        `planner-chats-${Date.now()}.json`,
        JSON.stringify(full, null, 2),
        'application/json'
      )
    } finally {
      setBusy(false)
    }
  }

  function exportCsv() {
    if (!selectedItems.length) return
    const rows = [
      [
        'id',
        'title',
        'model',
        'council_id',
        'phase',
        'created_ts',
        'updated_ts',
        'has_plan',
      ].join(','),
      ...selectedItems.map((s) =>
        [
          escapeCsv(s.id),
          escapeCsv(s.title),
          escapeCsv(s.model),
          escapeCsv(s.council_id ?? ''),
          escapeCsv(s.phase),
          String(s.created_ts),
          String(s.updated_ts),
          s.has_plan ? '1' : '0',
        ].join(',')
      ),
    ]
    downloadBlob(`planner-chats-${Date.now()}.csv`, rows.join('\n'), 'text/csv')
  }

  function exportMd() {
    if (!selectedItems.length) return
    const lines = selectedItems.map((s) => {
      const when = new Date(s.updated_ts * 1000).toLocaleString()
      return `- **${s.title.replace(/\n/g, ' ')}** · \`${s.id}\` · ${s.phase} · ${when}`
    })
    downloadBlob(
      `planner-chats-${Date.now()}.md`,
      lines.join('\n'),
      'text/markdown'
    )
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/30 p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Chat history
          </h3>
          <p className="text-sm text-slate-400 mt-1.5 leading-relaxed max-w-xl">
            Select conversations to delete in bulk or export. JSON includes full message and plan
            payloads; CSV and Markdown are summaries only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
          className="text-xs rounded-lg border border-slate-600/80 px-3 py-1.5 text-slate-200 hover:bg-white/5 disabled:opacity-40"
        >
          Refresh list
        </button>
      </div>

      {error && (
        <p className="text-xs text-rose-300/95 rounded-lg border border-rose-500/25 bg-rose-950/25 px-2.5 py-2">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !list.length}
          onClick={selectAll}
          className="text-xs rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-slate-200 hover:bg-white/[0.07] disabled:opacity-40"
        >
          {selected.size === list.length ? 'Clear selection' : 'Select all'}
        </button>
        <button
          type="button"
          disabled={busy || !selected.size}
          onClick={() => void onDelete()}
          className="text-xs rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-1.5 text-rose-100 hover:bg-rose-950/50 disabled:opacity-40"
        >
          Delete selected ({selected.size})
        </button>
        <button
          type="button"
          disabled={busy || !selected.size}
          onClick={() => void exportJson()}
          className="text-xs rounded-lg border border-violet-500/35 bg-violet-950/25 px-3 py-1.5 text-violet-100 hover:bg-violet-950/40 disabled:opacity-40"
        >
          Export JSON
        </button>
        <button
          type="button"
          disabled={busy || !selected.size}
          onClick={exportCsv}
          className="text-xs rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-slate-200 hover:bg-white/[0.07] disabled:opacity-40"
        >
          Export CSV
        </button>
        <button
          type="button"
          disabled={busy || !selected.size}
          onClick={exportMd}
          className="text-xs rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-slate-200 hover:bg-white/[0.07] disabled:opacity-40"
        >
          Export Markdown
        </button>
      </div>

      <div className="rounded-xl border border-white/[0.06] max-h-[min(50vh,28rem)] overflow-y-auto">
        {loading ? (
          <p className="p-4 text-sm text-slate-500">Loading…</p>
        ) : list.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No saved chats.</p>
        ) : (
          <ul className="divide-y divide-white/[0.06]">
            {list.map((s) => {
              const on = selected.has(s.id)
              return (
                <li key={s.id}>
                  <label className="flex items-start gap-3 px-3 py-2.5 hover:bg-white/[0.03] cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-1 rounded border-slate-600"
                      checked={on}
                      onChange={() => toggle(s.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-sm text-slate-100 font-medium line-clamp-2">
                        {s.title || 'Untitled'}
                      </span>
                      <span className="block text-[11px] text-slate-500 mt-0.5 font-mono truncate">
                        {s.id} · {s.phase}
                        {s.has_plan ? ' · plan' : ''} ·{' '}
                        {new Date(s.updated_ts * 1000).toLocaleDateString()}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
