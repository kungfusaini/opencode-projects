import { tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import path from "node:path"
import {
  archivePlan,
  createPlan,
  formatPlanList,
  listPlans,
  planWorkflowContext,
  recentEntriesForPlan,
  resolvePlan,
  updatePlan,
} from "./plans.js"
import {
  ALLOWED_TYPES,
  WORKLOG_VERSION,
  appendWorklogEntry,
  ensureStore,
  isDisabled,
  worklogRecap,
  worklogReminder,
} from "./worklog.js"
import { resolveContext } from "./projects.js"

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

function textFromParts(parts) {
  return parts
    .filter((part) => part?.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim()
}

function isPlanRelatedText(text) {
  return /\b(plan|planning|planned)\b/i.test(text) || /\b(resume|continue|execute|archive)\b.+\bplan\b/i.test(text)
}

function planCommandContext(info) {
  return [
    planWorkflowContext(info),
    "",
    "Available plan tools:",
    "- plan_create: create a durable active plan from a detailed markdown body.",
    "- plan_list: list active, archived, or all plans.",
    "- plan_read: read an active plan and recent worklog entries for it.",
    "- plan_update: update a plan only when strategy/scope/constraints/risks/completion criteria change.",
    "- plan_archive: archive a completed active plan and write a finish worklog entry.",
  ].join("\n")
}

function contextInfo(workdir, sessionID) {
  return ensureStore(resolveContext(workdir, { sessionID }))
}

function projectLogsRoot() {
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode", "project-logs")
}

function safeResolve(value) {
  if (!value || typeof value !== "string") return undefined
  if (value.startsWith("~")) return path.join(homedir(), value.slice(1))
  return path.resolve(value)
}

function isWithin(candidate, root) {
  const resolved = safeResolve(candidate)
  const base = safeResolve(root)
  if (!resolved || !base) return false
  const rel = path.relative(base, resolved)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function isProjectLogPath(value) {
  const resolved = safeResolve(value)
  return Boolean(resolved && isWithin(resolved, projectLogsRoot()))
}

function worklogScopeLabel(info) {
  const project = info.project?.name || info.project?.id || info.id
  return info.scope === "stream" && info.stream ? `${project} / ${info.stream.name || info.stream.id}` : project
}

function allowedWorklogPathMessage(info, requested) {
  return [
    `Blocked by opencode-worklog: this session is scoped to ${worklogScopeLabel(info)}.`,
    `Requested project-log path: ${requested}`,
    `Use only this worklog path for continuity: ${info.log}`,
  ].join("\n")
}

function shouldGuardPath(info, requested) {
  return isProjectLogPath(requested) && !isWithin(requested, info.dir)
}

function rewriteReadArgs(info, args) {
  const requested = args.filePath || args.path
  if (!shouldGuardPath(info, requested)) return
  args.filePath = info.log
  args.path = info.log
  args.offset = args.offset || 1
  args.limit = args.limit || 200
}

function rewriteSearchArgs(info, args) {
  const requested = args.path
  if (!shouldGuardPath(info, requested)) return
  args.path = info.dir
}

function rewriteBashArgs(info, args) {
  const command = typeof args.command === "string" ? args.command : ""
  if (!command.includes(projectLogsRoot())) return
  if (command.includes(info.dir)) return
  const escaped = JSON.stringify(allowedWorklogPathMessage(info, "bash command touching another project-log path"))
  args.command = `python3 - <<'PY'\nprint(${escaped})\nPY`
  args.description = "Blocked cross-stream worklog access"
}

function guardWorklogToolAccess(info, toolName, args) {
  if (!args || typeof args !== "object") return
  if (["read", "Read"].includes(toolName)) rewriteReadArgs(info, args)
  if (["grep", "Grep", "glob", "Glob"].includes(toolName)) rewriteSearchArgs(info, args)
  if (["bash", "Bash"].includes(toolName)) rewriteBashArgs(info, args)
}

function continuityContext(info) {
  return [
    worklogReminder(info),
    "Continuity behavior: when the user asks where we are, what the current state is, what we were doing, or similar, answer from the selected worklog recap first. Do not run git status, inspect unrelated files, or read project/sibling stream logs unless the user explicitly asks for repo status or broader investigation.",
    worklogRecap(info),
  ].join("\n\n")
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
    plan: tool.schema.string().optional().describe("Optional active plan id or path this worklog entry relates to"),
    session: tool.schema.string().optional().describe("Session id"),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    if (isDisabled(info.id)) {
      return "Worklog tracking is disabled for this project."
    }

    const type = args.type.trim().toLowerCase()
    if (!ALLOWED_TYPES.has(type)) {
      return `❌ Invalid type: ${args.type}`
    }

    context.metadata({ title: "Writing to worklog" })

    let planRef
    if (args.plan) {
      try {
        const plan = resolvePlan(info, args.plan, "all")
        planRef = { id: plan.id, title: plan.title, path: plan.path, status: plan.status }
      } catch {
        planRef = { id: args.plan, path: args.plan }
      }
    }

    const entry = {
      v: WORKLOG_VERSION,
      time: new Date().toISOString(),
      session: args.session || context.messageID || context.sessionID || "unknown",
      project: info.id,
      root: info.root,
      scope: info.scope,
      stream: info.stream ? { id: info.stream.id, name: info.stream.name } : undefined,
      type,
      summary: args.summary,
      task: args.task,
      next: args.next,
      reason: args.reason,
      lesson: args.lesson,
      blocker: args.blocker,
      result: args.result,
      plan: planRef,
      files: planRef?.path && !args.file?.includes(planRef.path) ? [planRef.path, ...(args.file || [])] : args.file,
    }

    appendWorklogEntry(info, entry)
    return {
      title: `Wrote to worklog: ${entry.summary}`,
      output: `${entry.type}: ${entry.summary}`,
    }
  },
})

const planCreateTool = tool({
  description: [
    "Create a durable active project plan under the current project's local opencode worklog store.",
    "Use this for detailed intended-route plans, not live checklists.",
    "The body should be thorough markdown: goal, context, recommended approach, phases, risks, completion criteria, and handoff notes.",
    "Do not use checkbox progress tracking in the plan; use todowrite for live session tracking and worklog_append for durable progress.",
  ].join(" "),
  args: {
    title: tool.schema.string().describe("Short human-readable plan title"),
    body: tool.schema.string().describe("Detailed markdown plan body"),
    task: tool.schema.string().optional().describe("Optional task label for the automatic worklog entry"),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    context.metadata({ title: "Creating plan" })
    const plan = createPlan(info, args)
    return {
      title: `Created plan: ${plan.title}`,
      output: [`Created active plan: ${plan.title}`, `Plan ID: ${plan.id}`, `Path: ${plan.path}`].join("\n"),
    }
  },
})

const planListTool = tool({
  description: "List durable project plans for the current project.",
  args: {
    status: tool.schema.string().optional().describe("Which plans to list: active, archive, or all. Defaults to active."),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    const status = ["active", "archive", "all"].includes(args.status) ? args.status : "active"
    const plans = listPlans(info, status)
    return {
      title: `${plans.length} ${status} plan${plans.length === 1 ? "" : "s"}`,
      output: formatPlanList(plans),
    }
  },
})

const planReadTool = tool({
  description: "Read a durable project plan and recent worklog entries that reference it.",
  args: {
    id: tool.schema.string().optional().describe("Plan id, path, or title. If omitted and one active plan exists, that plan is used."),
    status: tool.schema.string().optional().describe("Where to resolve the plan from: active, archive, or all. Defaults to active."),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    const status = ["active", "archive", "all"].includes(args.status) ? args.status : "active"
    context.metadata({ title: "Reading plan" })
    try {
      const plan = resolvePlan(info, args.id, status)
      const recent = recentEntriesForPlan(info, plan)
      const worklog = recent.length
        ? recent.map((entry) => `- ${entry.type}: ${entry.summary}`).join("\n")
        : "- none yet"
      return {
        title: `Read plan: ${plan.title}`,
        output: [`Path: ${plan.path}`, "", plan.content, "", "Recent worklog entries for this plan:", worklog].join("\n"),
      }
    } catch (error) {
      return `❌ ${error.message}`
    }
  },
})

const planUpdateTool = tool({
  description: [
    "Update an active durable project plan when the intended approach changes.",
    "Do not call this just to mark progress; use todowrite for live checklist progress and worklog_append for durable progress events.",
  ].join(" "),
  args: {
    id: tool.schema.string().optional().describe("Active plan id, path, or title. If omitted and one active plan exists, that plan is used."),
    title: tool.schema.string().optional().describe("Optional updated title"),
    body: tool.schema.string().describe("Full updated detailed markdown plan body"),
    reason: tool.schema.string().optional().describe("Why the intended route changed"),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    context.metadata({ title: "Updating plan" })
    try {
      const plan = updatePlan(info, args)
      return {
        title: `Updated plan: ${plan.title}`,
        output: [`Updated active plan: ${plan.title}`, `Plan ID: ${plan.id}`, `Path: ${plan.path}`].join("\n"),
      }
    } catch (error) {
      return `❌ ${error.message}`
    }
  },
})

const planArchiveTool = tool({
  description: "Archive a completed active project plan and append a finish entry to the worklog.",
  args: {
    id: tool.schema.string().optional().describe("Active plan id, path, or title. If omitted and one active plan exists, that plan is used."),
    result: tool.schema.string().optional().describe("Completion notes or final result summary"),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    context.metadata({ title: "Archiving plan" })
    try {
      const plan = archivePlan(info, args)
      return {
        title: `Archived plan: ${plan.title}`,
        output: [`Archived plan: ${plan.title}`, `Plan ID: ${plan.id}`, `Path: ${plan.path}`].join("\n"),
      }
    } catch (error) {
      return `❌ ${error.message}`
    }
  },
})

export async function server({ directory }) {
  return {
    tool: {
      worklog_append: worklogAppendTool,
      plan_create: planCreateTool,
      plan_list: planListTool,
      plan_read: planReadTool,
      plan_update: planUpdateTool,
      plan_archive: planArchiveTool,
    },
    "tool.execute.before": async (input, output) => {
      const info = contextInfo(directory, input.sessionID)
      guardWorklogToolAccess(info, input.tool, output.args)
    },
    "chat.message": async (input, output) => {
      if (getPendingCommandContext(input.sessionID)) return
      const text = textFromParts(output.parts)
      if (!isPlanRelatedText(text)) return
      const info = contextInfo(directory, input.sessionID)
      if (!isDisabled(info.id)) setPendingCommandContext(input.sessionID, planCommandContext(info))
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const info = contextInfo(directory, input.sessionID)
      const pending = getPendingCommandContext(input.sessionID)
      if (pending) {
        output.system.push(pending)
        return
      }

      if (!isDisabled(info.id)) output.system.push(continuityContext(info))
    },
    event: async ({ event }) => {
      const type = event?.type
      const properties = event?.properties
      const sessionID = properties?.sessionID
      if (typeof sessionID !== "string") return

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
