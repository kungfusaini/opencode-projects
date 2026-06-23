import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appendWorklogEntry, readAllEntries, WORKLOG_VERSION } from "./worklog.js"

export const PLAN_VERSION = 1
export const CURRENT_PLAN_VERSION = 1
const RECENT_PLAN_ENTRY_COUNT = 8

function slugify(input) {
  return input
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80)
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function stripMarkdownExtension(id) {
  return id.replace(/\.md$/i, "")
}

function ensurePlanDirs(info) {
  const root = path.join(info.dir, "plans")
  const active = path.join(root, "active")
  const archive = path.join(root, "archive")
  mkdirSync(active, { recursive: true })
  mkdirSync(archive, { recursive: true })
  return { root, active, archive }
}

function planFilePath(info, status, id) {
  const dirs = ensurePlanDirs(info)
  return path.join(status === "archive" ? dirs.archive : dirs.active, `${stripMarkdownExtension(id)}.md`)
}

function uniquePlanID(info, title) {
  const base = `${today()}-${slugify(title) || "plan"}`
  let id = base
  let index = 2
  while (existsSync(planFilePath(info, "active", id)) || existsSync(planFilePath(info, "archive", id))) {
    id = `${base}-${index++}`
  }
  return id
}

function planTitleFromContent(content, fallback) {
  const heading = content.match(/^#\s+(?:Plan:\s*)?(.+)$/im)?.[1]?.trim()
  return heading || fallback
}

function planSummary(plan) {
  return `${plan.status}: ${plan.title} (${plan.id})\n${plan.path}`
}

function formatCurrentRef(planRef) {
  if (!planRef) return undefined
  return {
    v: CURRENT_PLAN_VERSION,
    planID: planRef.id,
    planPath: planRef.path,
    status: planRef.status || "active",
    updatedAt: new Date().toISOString(),
  }
}

export function getCurrentPlanRef(info) {
  return readJson(currentPlanPath(info), undefined)
}

export function setCurrentPlanRef(info, plan) {
  mkdirSync(ensurePlanDirs(info).root, { recursive: true })
  const payload = formatCurrentRef(plan)
  writeFileSync(currentPlanPath(info), `${JSON.stringify(payload, null, 2)}\n`, "utf8")
  return payload
}

export function clearCurrentPlanRef(info) {
  const file = currentPlanPath(info)
  if (existsSync(file)) {
    try {
      unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
}

export function resolveCurrentPlan(info, status = "active") {
  const ref = getCurrentPlanRef(info)
  if (!ref || !ref.planPath) return undefined
  const plans = listPlans(info, status === "all" ? "all" : status)
  const current = plans.find((plan) => matchesCurrentPath(plan, ref))
  if (!current) {
    clearCurrentPlanRef(info)
    return undefined
  }
  return current
}

export function setCurrentPlan(info, input) {
  const plan = resolvePlan(info, input, "all")
  setCurrentPlanRef(info, planRef(plan))
  return plan
}

function readPlanAt(file, status) {
  const content = readFileSync(file, "utf8")
  const stats = statSync(file)
  const id = stripMarkdownExtension(path.basename(file))
  return {
    id,
    status,
    title: planTitleFromContent(content, id),
    path: file,
    updatedAt: stats.mtime.toISOString(),
    content,
  }
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function currentPlanPath(info) {
  const dirs = ensurePlanDirs(info)
  return path.join(dirs.root, "current.json")
}

function matchesCurrentPath(plan, ref) {
  if (!ref) return false
  if (typeof ref.planPath === "string" && plan.path === ref.planPath) return true
  if (typeof ref.planID === "string" && plan.id === stripMarkdownExtension(ref.planID)) return true
  return false
}

function listDirPlans(dir, status) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readPlanAt(path.join(dir, name), status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function planRef(plan) {
  return {
    id: plan.id,
    title: plan.title,
    path: plan.path,
    status: plan.status,
  }
}

function appendPlanEntry(info, type, summary, plan, extra = {}) {
  appendWorklogEntry(info, {
    v: WORKLOG_VERSION,
    time: new Date().toISOString(),
    type,
    summary,
    project: info.id,
    root: info.root,
    plan: planRef(plan),
    files: [plan.path, ...(extra.files || [])],
    ...extra,
  })
}

export function planDirs(info) {
  return ensurePlanDirs(info)
}

export function listPlans(info, status = "active") {
  const dirs = ensurePlanDirs(info)
  if (status === "all") return [...listDirPlans(dirs.active, "active"), ...listDirPlans(dirs.archive, "archive")]
  if (status === "archive") return listDirPlans(dirs.archive, "archive")
  return listDirPlans(dirs.active, "active")
}

export function resolvePlan(info, id, status = "active") {
  const target = id ? stripMarkdownExtension(id.trim()) : ""
  const candidates = listPlans(info, status)
  if (target) {
    const found = candidates.find((plan) => plan.id === target || plan.path === id || plan.title === id)
    if (!found) throw new Error(`No ${status} plan found for: ${id}`)
    return found
  }

  const active = status === "archive" ? candidates : listPlans(info, "active")
  if (active.length === 1) return active[0]
  if (active.length === 0) throw new Error("No active plans found.")
  throw new Error(`Multiple active plans found: ${active.map((plan) => plan.id).join(", ")}`)
}

export function createPlan(info, input) {
  const title = input.title.trim()
  const id = uniquePlanID(info, title)
  const file = planFilePath(info, "active", id)
  const created = new Date().toISOString()
  const body = input.body.trim()
  const content = [
    `# Plan: ${title}`,
    "",
    `Status: active`,
    `Plan ID: ${id}`,
    `Created: ${created}`,
    `Updated: ${created}`,
    `Project: ${info.id}`,
    `Worklog: ${info.log}`,
    "",
    "Plan rule: use this file for the intended route. Use todowrite for the live session checklist and worklog entries for durable progress. Do not edit this plan just to mark checklist progress.",
    "",
    body.startsWith("#") ? body.replace(/^#\s+.+\n+/, "") : body,
    "",
  ].join("\n")

  writeFileSync(file, content, "utf8")
  const plan = readPlanAt(file, "active")
  appendPlanEntry(info, "start", `Created active plan: ${title}`, plan, {
    task: input.task,
    next: "Use the plan for intended direction, todowrite for live execution, and worklog entries for progress.",
  })
  return plan
}

export function updatePlan(info, input) {
  const plan = resolvePlan(info, input.id, "active")
  const updated = new Date().toISOString()
  const body = input.body.trim()
  const content = [
    `# Plan: ${input.title?.trim() || plan.title}`,
    "",
    `Status: active`,
    `Plan ID: ${plan.id}`,
    `Updated: ${updated}`,
    `Project: ${info.id}`,
    `Worklog: ${info.log}`,
    "",
    "Plan rule: use this file for the intended route. Use todowrite for the live session checklist and worklog entries for durable progress. Do not edit this plan just to mark checklist progress.",
    "",
    body.startsWith("#") ? body.replace(/^#\s+.+\n+/, "") : body,
    "",
  ].join("\n")
  writeFileSync(plan.path, content, "utf8")
  const updatedPlan = readPlanAt(plan.path, "active")
  appendPlanEntry(info, "decision", `Updated active plan: ${updatedPlan.title}`, updatedPlan, {
    reason: input.reason || "The intended approach, scope, constraints, risks, or completion criteria changed.",
  })
  return updatedPlan
}

export function archivePlan(info, input = {}) {
  const plan = resolvePlan(info, input.id, "active")
  const archived = new Date().toISOString()
  const archivePath = planFilePath(info, "archive", plan.id)
  const archivedContent = plan.content
    .replace(/^Status:\s*active$/im, "Status: archived")
    .replace(/^Updated:\s*.+$/im, `Updated: ${archived}`)
  const completionNotes = input.result?.trim()
    ? `\n\n## Completion notes\n\nArchived: ${archived}\n\n${input.result.trim()}\n`
    : `\n\n## Completion notes\n\nArchived: ${archived}\n`
  writeFileSync(plan.path, `${archivedContent.trimEnd()}${completionNotes}`, "utf8")
  renameSync(plan.path, archivePath)
  const archivedPlan = readPlanAt(archivePath, "archive")
  const ref = getCurrentPlanRef(info)
  if (ref && matchesCurrentPath(plan, ref)) {
    clearCurrentPlanRef(info)
  }
  appendPlanEntry(info, "finish", `Archived completed plan: ${archivedPlan.title}`, archivedPlan, {
    result: input.result,
    files: [archivePath],
  })
  return archivedPlan
}

export function recentEntriesForPlan(info, plan, limit = RECENT_PLAN_ENTRY_COUNT) {
  return readAllEntries(info.log)
    .filter((entry) => {
      if (entry?.plan?.id === plan.id) return true
      if (entry?.plan?.path === plan.path) return true
      if (Array.isArray(entry?.files) && entry.files.includes(plan.path)) return true
      if (Array.isArray(entry?.file) && entry.file.includes(plan.path)) return true
      return false
    })
    .slice(-limit)
}

function compactPlanEntry(entry) {
  const bits = [`- ${entry.type}: ${entry.summary}`]
  if (entry.next) bits.push(`next=${entry.next}`)
  if (entry.result) bits.push(`result=${entry.result}`)
  if (entry.blocker) bits.push(`blocker=${entry.blocker}`)
  if (entry.reason) bits.push(`reason=${entry.reason}`)
  return bits.join(" | ")
}

export function planWorkflowContext(info) {
  const active = listPlans(info, "active")
  const current = resolveCurrentPlan(info, "all")
  const currentLine = current ? `${current.title} (${current.id})\n  ${current.path}` : "none"
  const lines = [
    "Project plan workflow is available through the opencode-projects plugin.",
    `Plan storage: ${path.join(info.dir, "plans")}`,
    "Plan model: plan = intended route; worklog = durable progress/events; todowrite = live session checklist.",
    "When working from an active plan:",
    "- Read the active plan before acting.",
    "- Use todowrite for the current session's working checklist.",
    "- Use worklog_append for durable progress, blockers, detours, decisions, mistakes, next steps, and completion.",
    "- Include the active plan path in worklog entries, either via the plan field or the file field.",
    "- Do not edit the plan just to mark checklist progress.",
    "- Only update the plan when the intended approach, scope, constraints, risks, or completion criteria change.",
    "",
    `Current plan: ${currentLine}`,
    "Active plans:",
    active.length ? active.map((plan) => `- ${plan.title} (${plan.id})\n  ${plan.path}`).join("\n") : "- none",
  ]

  if (active.length === 1) {
    const recent = recentEntriesForPlan(info, active[0])
    lines.push("", `Recent worklog entries for ${active[0].id}:`)
    lines.push(recent.length ? recent.map(compactPlanEntry).join("\n") : "- none yet")
  }

  if (active.length > 1) lines.push("", "Multiple active plans exist. Ask the user which plan to use before executing.")
  return lines.join("\n")
}

export function formatPlanList(info, plans) {
  if (!plans.length) return "No plans found."
  const current = resolveCurrentPlan(info, "all")
  return plans
    .map((plan) => {
      const currentMarker = current && plan.id === current.id ? " [current]" : ""
      return `${planSummary(plan)}${currentMarker}`
    })
    .join("\n\n")
}
