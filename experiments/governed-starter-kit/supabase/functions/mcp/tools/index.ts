import type { McpServer } from 'mcp-sdk'

import type { ToolContext } from './types.ts'
import { registerAppTools } from './app.ts'
import { registerWhoamiTool } from './whoami.ts'

export type { ToolContext } from './types.ts'

// The one composition point for this server. Add one registration call for
// each tool module; the MCP SDK rejects duplicate protocol tool names.
export function registerTools(server: McpServer, context: ToolContext): void {
  registerWhoamiTool(server, context)
  registerAppTools(server, context)
}
