'use client'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { useState } from 'react'
import { ReplyMarkdown } from './reply-markdown'

// Transcript as the Messages API sees it. The function returns it with every
// reply and we send it back unchanged on the next turn; it holds no identity -
// the function takes that from the session JWT that functions.invoke attaches.
type ApiMessage = { role: 'user' | 'assistant'; content: unknown }

interface ToolEvent {
  status: 'ok' | 'error'
  tool: string
  input: Record<string, unknown>
  error?: string
  result?: unknown
}

interface Pending {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  summary: string
  others: unknown[]
}

interface AgentTurn {
  messages: ApiMessage[]
  events: ToolEvent[]
  reply?: string
  pending?: Pending
  error?: string
}

type LogItem =
  | { kind: 'user' | 'assistant' | 'error'; text: string }
  | { kind: 'tool'; event: ToolEvent }

function describe(e: ToolEvent): string {
  if (e.status === 'error') return e.error ?? 'error'
  if (Array.isArray(e.result)) return `${e.result.length} result(s)`
  return 'done'
}

export default function AssistantClient() {
  const supabase = createClient()
  const [messages, setMessages] = useState<ApiMessage[]>([])
  const [log, setLog] = useState<LogItem[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  // Returns false when the call failed and the transcript was not advanced.
  const invoke = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    const { data, error } = await supabase.functions.invoke<AgentTurn>('agent', { body })
    setBusy(false)
    if (error) {
      let text = error.message
      if (error instanceof FunctionsHttpError) {
        const j = (await error.context.json().catch(() => null)) as { error?: string } | null
        if (j?.error) text = j.error
      }
      setLog((l) => [...l, { kind: 'error', text }])
      return false
    }
    if (!data) return false
    setMessages(data.messages)
    setPending(data.pending ?? null)
    setLog((l) => [
      ...l,
      ...data.events.map((event): LogItem => ({ kind: 'tool', event })),
      ...(data.reply ? [{ kind: 'assistant' as const, text: data.reply }] : []),
      ...(data.error ? [{ kind: 'error' as const, text: data.error }] : []),
    ])
    return true
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || busy || pending) return
    setInput('')
    setLog((l) => [...l, { kind: 'user', text }])
    await invoke({ mode: 'chat', messages: [...messages, { role: 'user', content: text }] })
  }

  const answer = async (approve: boolean) => {
    if (!pending) return
    const p = pending
    setPending(null)
    // A failed confirm ran nothing (the function only fails before the write),
    // so put the card back and let the user retry or cancel.
    if (!(await invoke({ mode: 'confirm', messages, pending: p, approve }))) setPending(p)
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {log.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask about purchasing policy, list your department&apos;s requests, submit one, or (as a manager) decide one.
          </p>
        )}
        {log.map((item, i) =>
          item.kind === 'tool' ? (
            <div key={i} className="text-xs font-mono text-muted-foreground border-l-2 pl-2">
              {item.event.tool}({JSON.stringify(item.event.input)}) -{' '}
              <span className={item.event.status === 'error' ? 'text-red-600' : ''}>{describe(item.event)}</span>
            </div>
          ) : item.kind === 'assistant' ? (
            <div
              key={i}
              data-kind="assistant"
              className="text-sm space-y-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_code]:font-mono [&_code]:text-xs"
            >
              <ReplyMarkdown text={item.text} />
            </div>
          ) : (
            <div
              key={i}
              data-kind={item.kind}
              className={item.kind === 'user' ? 'text-sm font-medium' : 'text-sm text-red-600'}
            >
              {item.kind === 'user' ? '> ' : ''}
              {item.text}
            </div>
          ),
        )}
        {busy && <p className="text-xs text-muted-foreground">Working...</p>}
      </div>

      {pending && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <p className="text-sm">
              <span className="font-mono text-xs">{pending.tool}</span>: {pending.summary}
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => answer(true)} disabled={busy}>
                Confirm
              </Button>
              <Button size="sm" variant="outline" onClick={() => answer(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <form onSubmit={send} className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={pending ? 'Confirm or cancel the action above first' : 'Message the assistant'}
          disabled={busy || !!pending}
          aria-label="Message"
        />
        <Button type="submit" disabled={busy || !!pending || !input.trim()}>
          Send
        </Button>
      </form>
    </div>
  )
}
