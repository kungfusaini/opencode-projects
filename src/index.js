import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import {
  archivePlan,
  createPlan,
  formatPlanList,
  listPlans,
  resolveCurrentPlan,
  setCurrentPlan,
  clearCurrentPlanRef,
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
  readAllEntries,
  worklogRecap,
  worklogReminder,
} from "./worklog.js"
import { resolveContext } from "./projects.js"
import { DEFAULT_PLAN_AGENT } from "./plan-agent.js"

export const id = "opencode-worklog"

function applyPlanAgentOverrides(cfg) {
  cfg.agent = cfg.agent || {}
  cfg.agent.plan = { ...DEFAULT_PLAN_AGENT }
}

const PENDING_COMMAND_CONTEXT_TTL_MS = 10 * 60 * 1000

const pendingCommandContext = new Map()

export async function config(cfg) {
  applyPlanAgentOverrides(cfg)
}

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

function currentPlanContextLine(info) {
  const current = resolveCurrentPlan(info, "all")
  if (!current) return "Current plan: none"
  return `Current plan: ${current.title} (${current.id})\n  Path: ${current.path}`
}

function planCommandContext(info) {
  return [
    planWorkflowContext(info),
    currentPlanContextLine(info),
    "",
    "Available plan tools:",
    "- plan_create: create a durable active plan from a detailed markdown body.",
    "- plan_current: show, set, or clear the current plan pointer for the active scope.",
    "- plan_list: list active, archived, or all plans.",
    "- plan_read: read current plan by default (if set), otherwise active plan resolution rules apply.",
    "- plan_update: update a plan only when strategy/scope/constraints/risks/completion criteria change.",
    "- plan_archive: archive a completed active plan and write a finish worklog entry.",
  ].join("\n")
}

function contextInfo(workdir, sessionID) {
  return ensureStore(resolveContext(workdir, { sessionID }))
}

function continuityContext(info) {
  return [
    worklogReminder(info),
    currentPlanContextLine(info),
    "Continuity behavior: when the user asks where we are, what the current state is, what we were doing, or similar, answer from the selected worklog recap first. Do not run git status, inspect unrelated files, or read project/sibling stream logs unless the user explicitly asks for repo status, another session, another project, project-wide history, or broader investigation.",
    worklogRecap(info),
  ].join("\n\n")
}

function projectInfoFromStreamContext(info) {
  if (info.scope !== "stream" || !info.project) return undefined
  return ensureStore({
    scope: "project",
    project: info.project,
    id: info.project.id,
    root: info.project.root,
    dir: info.project.dir,
    log: info.project.worklog,
    plans: path.join(info.project.dir, "plans"),
  })
}

function shouldRollupStreamEntry(entry, args) {
  if (args.projectImpact === true) return true
  if (entry.type === "start" || entry.type === "finish" || entry.type === "mistake") return true
  return false
}

function validateWorklogEntry(args, type) {
  if (type === "decision" && !args.reason?.trim()) return "❌ decision entries require reason"
  if (type === "mistake" && !args.lesson?.trim()) return "❌ mistake entries require lesson"
  if (type === "stuck" && !args.blocker?.trim()) return "❌ stuck entries require blocker"
  return undefined
}

function streamRollupSummary(entry, info) {
  const stream = info.stream?.name || info.stream?.id || "stream"
  return `Stream ${stream}: ${entry.summary}`
}

function streamRollupSource(entry, info) {
  return {
    kind: "stream-rollup",
    streamID: info.stream?.id,
    streamName: info.stream?.name,
    streamLog: info.log,
    streamEntryTime: entry.time,
    streamEntryType: entry.type,
    streamEntrySummary: entry.summary,
  }
}

function alreadyRolledUp(projectInfo, source) {
  return readAllEntries(projectInfo.log).some((entry) => {
    const existing = entry.source
    return existing?.kind === source.kind
      && existing.streamID === source.streamID
      && existing.streamEntryTime === source.streamEntryTime
      && existing.streamEntryType === source.streamEntryType
      && existing.streamEntrySummary === source.streamEntrySummary
  })
}

function appendStreamRollup(info, entry, args) {
  if (info.scope !== "stream" || !info.stream) return undefined
  if (!shouldRollupStreamEntry(entry, args)) return undefined

  const projectInfo = projectInfoFromStreamContext(info)
  if (!projectInfo || isDisabled(projectInfo.id)) return undefined

  const source = streamRollupSource(entry, info)
  if (alreadyRolledUp(projectInfo, source)) return { skipped: true }

  const rollup = {
    v: WORKLOG_VERSION,
    time: new Date().toISOString(),
    session: entry.session,
    project: projectInfo.id,
    root: projectInfo.root,
    scope: "project",
    stream: { id: info.stream.id, name: info.stream.name },
    type: entry.type,
    summary: streamRollupSummary(entry, info),
    task: entry.task,
    next: entry.next,
    reason: entry.reason,
    lesson: entry.lesson,
    blocker: entry.blocker,
    result: entry.result,
    plan: entry.plan,
    files: entry.files,
    source,
  }
  appendWorklogEntry(projectInfo, rollup)
  return rollup
}

const worklogAppendTool = tool({
  description: "Append a worklog event to the current project or stream worklog. In stream scope, high-signal entries automatically roll up to the parent project; set projectImpact=true when a stream entry should be visible in project memory.",
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
    projectImpact: tool.schema.boolean().optional().describe("Set true when this stream entry affects project-level direction, architecture, release state, workflow, or future agents and should roll up to the parent project log."),
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
    const validationError = validateWorklogEntry(args, type)
    if (validationError) return validationError

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
      projectImpact: args.projectImpact === true ? true : undefined,
      files: planRef?.path && !args.file?.includes(planRef.path) ? [planRef.path, ...(args.file || [])] : args.file,
    }

    appendWorklogEntry(info, entry)
    const rollup = appendStreamRollup(info, entry, args)
    return {
      title: `Wrote to worklog: ${entry.summary}`,
      output: [
        `${entry.type}: ${entry.summary}`,
        info.scope === "stream" ? `Project rollup: ${rollup?.summary || (rollup?.skipped ? "already recorded" : "no")}` : undefined,
      ].filter(Boolean).join("\n"),
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
    const current = resolveCurrentPlan(info, "all")
    const plan = createPlan(info, args)
    return {
      title: `Created plan: ${plan.title}`,
      output: [
        `Created active plan: ${plan.title}`,
        `Plan ID: ${plan.id}`,
        `Path: ${plan.path}`,
        current ? `Current plan remains: ${current.title} (${current.id})` : "No current plan is selected yet.",
      ].join("\n"),
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
      output: formatPlanList(info, plans),
    }
  },
})

const planCurrentTool = tool({
  description: [
    "Manage the current plan pointer for the active scope (project or stream).",
    "Use action=show to read the current plan, set to choose one, and clear to unset current selection.",
  ].join(" "),
  args: {
    action: tool.schema.string().optional().describe("Action to take: show, set, or clear."),
    id: tool.schema.string().optional().describe("Plan id, path, or title. Required for action=set."),
  },
  async execute(args, context) {
    const info = contextInfo(context.directory, context.sessionID)
    context.metadata({ title: "Managing current plan" })
    try {
      const action = (args.action || "show").trim().toLowerCase()

      if (action === "clear") {
        clearCurrentPlanRef(info)
        return {
          title: "Cleared current plan",
          output: "Current plan pointer cleared.",
        }
      }

      if (action === "set") {
        if (!args.id) return "❌ action=set requires an id"
        const plan = setCurrentPlan(info, args.id)
        return {
          title: `Set current plan: ${plan.title}`,
          output: [`Current plan set to ${plan.title} (${plan.id})`, `Path: ${plan.path}`].join("\n"),
        }
      }

      if (action !== "show") {
        return "❌ action must be one of: show, set, clear"
      }

      const current = resolveCurrentPlan(info, "all")
      if (!current) {
        return {
          title: "No current plan",
          output: "No current plan is set for this scope. Use plan_current with action=set to choose one.",
        }
      }

      return {
        title: `Current plan: ${current.title}`,
        output: [`Path: ${current.path}`, "", current.content].join("\n"),
      }
    } catch (error) {
      return `❌ ${error.message}`
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
      if (!args.id) {
        const current = resolveCurrentPlan(info, status)
        if (current) {
          const recentCurrent = recentEntriesForPlan(info, current)
          const worklogCurrent = recentCurrent.length
            ? recentCurrent.map((entry) => `- ${entry.type}: ${entry.summary}`).join("\n")
            : "- none yet"
          return {
            title: `Read current plan: ${current.title}`,
            output: [`Path: ${current.path}`, "", current.content, "", "Recent worklog entries for this plan:", worklogCurrent].join("\n"),
          }
        }
      }

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
      plan_current: planCurrentTool,
      plan_create: planCreateTool,
      plan_list: planListTool,
      plan_read: planReadTool,
      plan_update: planUpdateTool,
      plan_archive: planArchiveTool,
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
  config,
  server,
}
