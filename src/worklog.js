import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const WORKLOG_VERSION = 1
export const ALLOWED_TYPES = new Set(["start", "progress", "decision", "mistake", "stuck", "finish", "next", "note"])
const RECAP_ENTRY_COUNT = 12

function slugify(input) {
  return input
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80)
}

export function projectInfo(workdir) {
  const cwd = path.resolve(workdir)
  const root = cwd
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12)
  const parent = path.basename(path.dirname(root))
  const leaf = path.basename(root) || "project"
  const base = slugify(parent && parent !== path.sep ? `${parent}-${leaf}` : leaf)
  const id = `${base || "project"}--${hash}`
  const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
  const dir = path.join(dataHome, "opencode", "project-logs", id)
  return { cwd, root, id, dir, log: path.join(dir, "worklog.jsonl") }
}

function stateFile() {
  const stateRoot = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
  const dir = path.join(stateRoot, "opencode", "worklog")
  return { dir, file: path.join(dir, "state.json") }
}

function readState() {
  const { file } = stateFile()
  if (!existsSync(file)) return { disabled: {} }
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    const disabled = parsed?.disabled && typeof parsed.disabled === "object" ? parsed.disabled : {}
    return { ...parsed, disabled }
  } catch {
    return { disabled: {} }
  }
}

function writeState(state) {
  const { dir, file } = stateFile()
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
}

export function isDisabled(projectID) {
  return Boolean(readState().disabled[projectID])
}

export function setDisabled(projectID, disabled) {
  const state = readState()
  writeState({
    ...state,
    disabled: {
      ...state.disabled,
      [projectID]: disabled,
    },
    updatedAt: new Date().toISOString(),
  })
}

export function ensureStore(info) {
  mkdirSync(info.dir, { recursive: true })
  if (!existsSync(info.log)) {
    const first = {
      v: WORKLOG_VERSION,
      time: new Date().toISOString(),
      type: "note",
      summary: "Created worklog file for this project.",
      next: "Append the first start/progress/decision entry when work begins.",
      project: info.id,
      root: info.root,
    }
    writeFileSync(info.log, `${JSON.stringify(first)}\n`, "utf8")
  }
  return info
}

export function parseEntries(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function readAllEntries(file) {
  if (!existsSync(file)) return []
  return parseEntries(readFileSync(file, "utf8"))
}

export function appendWorklogEntry(info, entry) {
  ensureStore(info)
  appendFileSync(info.log, `${JSON.stringify(entry)}\n`, "utf8")
}

export function projectLabel(info) {
  return info.id.replace(/--[a-f0-9]+$/i, "") || path.basename(info.root) || info.id
}

export function latestSummary(info) {
  const latest = readAllEntries(info.log).at(-1)
  if (!latest) return "No recent worklog summary"
  if (latest.summary) return latest.summary
  if (latest.next) return latest.next
  if (latest.result) return latest.result
  return `${latest.type} update recorded`
}

function compactEntry(entry) {
  const bits = [`- ${entry.type}: ${entry.summary}`]
  if (entry.task) bits.push(`task=${entry.task}`)
  if (entry.next) bits.push(`next=${entry.next}`)
  if (entry.result) bits.push(`result=${entry.result}`)
  if (entry.blocker) bits.push(`blocker=${entry.blocker}`)
  if (entry.reason) bits.push(`reason=${entry.reason}`)
  if (entry.lesson) bits.push(`lesson=${entry.lesson}`)
  return bits.join(" | ")
}

export function worklogRecap(info) {
  const entries = readAllEntries(info.log)
  const recent = entries.slice(-RECAP_ENTRY_COUNT)
  const latest = entries.at(-1)

  return [
    "Worklog recap for this project.",
    `Worklog file: ${info.log}`,
    `Project: ${projectLabel(info)}`,
    latest ? `Latest status: ${latest.summary}` : "Latest status: none yet",
    "Recent worklog entries:",
    recent.length ? recent.map(compactEntry).join("\n") : "- none yet",
    "Use this recap to orient yourself. Do not dump the raw entries into the user-visible response.",
    "If deeper project history is needed later, read the worklog file above.",
  ].join("\n")
}

export function worklogReminder(info) {
  return `Worklog tracking is enabled. For meaningful progress, decisions, blockers, mistakes, finishes, or next steps, append a concise entry with worklog_append. If deeper project history is needed, read the project worklog file: ${info.log}`
}
