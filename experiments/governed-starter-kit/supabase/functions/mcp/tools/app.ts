import type { McpServer } from 'mcp-sdk'
import { z } from 'npm:zod@4.6.2'

import { jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// Tools added on top of the block's whoami, one per app function. None of them
// takes a user id, department or role: the caller's RLS-scoped client and the
// policies in sql/10-app.sql and sql/60-mcp.sql decide every outcome.
// Import pins match the block's own import and its deno.lock.

export function registerAppTools(server: McpServer, { supabase }: ToolContext): void {
  server.registerTool(
    'list_purchase_requests',
    {
      description: 'List the purchase requests the signed-in user may see (their own department), newest first.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const { data, error } = await supabase
        .from('purchase_requests')
        .select('id, item, amount, status, department_id')
        .order('created_at', { ascending: false })
      return error ? runtimeErrorResult(error) : jsonResult({ count: data.length, rows: data })
    }
  )

  server.registerTool(
    'decide_purchase_request',
    {
      description:
        'Approve or reject a pending purchase request. Only a manager of the same department may decide, and never their own request.',
      inputSchema: z.object({
        request_id: z.string().uuid(),
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(500).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ request_id, decision, note }) => {
      const { data, error } = await supabase.rpc('decide_purchase_request', {
        request_id,
        decision,
        note: note ?? null,
      })
      return error ? runtimeErrorResult(error) : jsonResult(data)
    }
  )

  server.registerTool(
    'list_client_notes',
    {
      description:
        'List notes scoped to the calling MCP client. The policy compares the token client_id claim with the row, so each OAuth client sees only its own notes and a product session (no client_id) sees only unscoped ones.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const { data, error } = await supabase.from('mcp_notes').select('note').order('note')
      return error ? runtimeErrorResult(error) : jsonResult({ notes: data.map((r) => r.note) })
    }
  )
}
