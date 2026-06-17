import { tool } from "@opencode-ai/plugin"
import {
  ALLOWED_TYPES,
  WORKLOG_VERSION,
  appendWorklogEntry,
  ensureStore,
  isDisabled,
  latestSummary,
  projectInfo,
  projectLabel,
  setDisabled,
  worklogRecap,
  worklogReminder,
} from "./worklog.js"

export const id = "opencode-worklog"

const PENDING_COMMAND_CONTEXT_TTL_MS = 10 * 60 * 1000

const pendingCommandContext = new Map()

function clearExpiredPendingContexts() {
  const now = Date.now()
  for (const [sessionID, pending] of pendingCommandContext.entries()) {
    if (pending.expiresAt <= now) pendingCommandContext.delete(sessionID)
  }
}

function setPendingCommandContext(sessionID, text) {
  clearExpiredPendingContexts()
  pendingCommandContext.set(sessionID, {
    text,
    expiresAt: Date.now() + PENDING_COMMAND_CONTEXT_TTL_MS,
  })
}

function getPendingCommandContext(sessionID) {
  clearExpiredPendingContexts()
  return pendingCommandContext.get(sessionID)?.text
}

function clearPendingCommandContext(sessionID) {
  pendingCommandContext.delete(sessionID)
}

function setCommandResponse(parts, text, synthetic = false) {
  const output = parts.find((part) => part?.type === "text" && typeof part.text === "string")
  if (output && output.type === "text" && typeof output.text === "string") {
    output.text = text
    if (synthetic) output.synthetic = true
    else delete output.synthetic
    return
  }

  parts.unshift({ type: "text", text, ...(synthetic ? { synthetic: true } : {}) })
}

function textFromParts(parts) {
  return parts
    .filter((part) => part?.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

function worklogCommandContext(info, argumentsText) {
  const label = projectLabel(info)

  if (argumentsText.trim()) {
    return {
      userText: "/worklog",
      systemText: "The user invoked /worklog with unsupported arguments. Respond with one line: Usage: /worklog",
    }
  }

  const enabled = !isDisabled(info.id)
  if (enabled) {
    setDisabled(info.id, true)
    return {
      userText: "/worklog",
      systemText: [
        `The user invoked /worklog. Worklog tracking was disabled for project ${label}.`,
        "No tool calls or file reads are needed for this command response.",
        `Respond with one line: Worklog disabled · project: ${label}`,
      ].join("\n"),
    }
  }

  setDisabled(info.id, false)
  return {
    userText: "/worklog",
    systemText: [
      "The user invoked /worklog. Worklog tracking was enabled for this project.",
      "Use the recap below as hidden orientation context for this response. No tool calls or file reads are needed to answer this command.",
      worklogRecap(info),
      "Produce a concise durable orientation summary for the user.",
      "Do not dump raw worklog entries. Do not mention hidden context or implementation details. Do not mention the worklog path unless the user asks for it.",
      `Start with: Worklog enabled · project: ${label}`,
      `Include a short current status based on the recap. If no useful status exists, use: Current status: ${latestSummary(info)}`,
    ].join("\n\n"),
  }
}

const worklogAppendTool = tool({
  description: "Append a worklog event to the current project worklog",
  args: {
    type: tool.schema.string().describe("Event type: start, progress, decision, mistake, stuck, finish, next, note"),
    summary: tool.schema.string().describe("Short summary text"),
    task: tool.schema.string().optional().describe("Optional task context"),
    next: tool.schema.string().optional().describe("Next action/context"),
    reason: tool.schema.string().optional().describe("Reason for decision/mistake"),
    lesson: tool.schema.string().optional().describe("Lesson for mistake"),
    blocker: tool.schema.string().optional().describe("What is blocking progress"),
    result: tool.schema.string().optional().describe("Result summary"),
    file: tool.schema.array(tool.schema.string()).optional().describe("Files related to this entry"),
    session: tool.schema.string().optional().describe("Session id"),
  },
  async execute(args, context) {
    const info = ensureStore(projectInfo(context.directory))
    if (isDisabled(info.id)) {
      return "Worklog tracking is disabled for this project."
    }

    const type = args.type.trim().toLowerCase()
    if (!ALLOWED_TYPES.has(type)) {
      return `❌ Invalid type: ${args.type}`
    }

    context.metadata({ title: "Writing to worklog" })

    const entry = {
      v: WORKLOG_VERSION,
      time: new Date().toISOString(),
      session: args.session || context.messageID || context.sessionID || "unknown",
      project: info.id,
      root: info.root,
      type,
      summary: args.summary,
      task: args.task,
      next: args.next,
      reason: args.reason,
      lesson: args.lesson,
      blocker: args.blocker,
      result: args.result,
      files: args.file,
    }

    appendWorklogEntry(info, entry)
    return {
      title: `Wrote to worklog: ${entry.summary}`,
      output: `${entry.type}: ${entry.summary}`,
    }
  },
})

export async function server({ directory }) {
  return {
    tool: {
      worklog_append: worklogAppendTool,
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "worklog") return

      const info = ensureStore(projectInfo(directory))
      const response = worklogCommandContext(info, input.arguments)
      setCommandResponse(output.parts, response.userText)
      setPendingCommandContext(input.sessionID, response.systemText)
    },
    "chat.message": async (input, output) => {
      if (getPendingCommandContext(input.sessionID)) return
      if (textFromParts(output.parts) !== "/worklog") return

      const info = ensureStore(projectInfo(directory))
      const response = worklogCommandContext(info, "")
      setCommandResponse(output.parts, response.userText)
      setPendingCommandContext(input.sessionID, response.systemText)
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const info = ensureStore(projectInfo(directory))
      const pending = getPendingCommandContext(input.sessionID)
      if (pending) {
        output.system.push(pending)
        return
      }

      if (!isDisabled(info.id)) output.system.push(worklogReminder(info))
    },
    event: async ({ event }) => {
      const type = event?.type
      const properties = event?.properties
      const sessionID = properties?.sessionID
      if (typeof sessionID !== "string") return

      if (type === "command.executed" && properties?.name === "worklog") {
        clearPendingCommandContext(sessionID)
        return
      }

      if (type === "message.updated" && properties?.info?.role === "assistant") {
        const finish = properties.info.finish
        if (finish && !["tool-calls", "unknown"].includes(finish)) clearPendingCommandContext(sessionID)
      }
    },
  }
}

export default {
  id,
  server,
}
