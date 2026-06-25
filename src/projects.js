import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { projectInfo } from "./worklog.js"

export const PROJECT_REGISTRY_VERSION = 1
export const STREAM_VERSION = 1

function slugify(input) {
  return input
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80)
}

function dataHome() {
  return process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
}

function stateHome() {
  return process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
}

function now() {
  return new Date().toISOString()
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function registryPath() {
  const dir = path.join(dataHome(), "opencode", "project-logs")
  return { dir, file: path.join(dir, "registry.json") }
}

export function readRegistry() {
  const { file } = registryPath()
  const registry = readJson(file, { v: PROJECT_REGISTRY_VERSION, projects: {} })
  return {
    v: registry.v || PROJECT_REGISTRY_VERSION,
    projects: registry.projects && typeof registry.projects === "object" ? registry.projects : {},
  }
}

export function listProjects() {
  return Object.values(readRegistry().projects).filter((project) => (project.status || "active") === "active").sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    const byDate = String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
    if (byDate) return byDate
    const byName = String(a.name || a.id).localeCompare(String(b.name || b.id))
    if (byName) return byName
    return String(a.id).localeCompare(String(b.id))
  })
}

export function listArchivedProjects() {
  return Object.values(readRegistry().projects)
    .filter((project) => project.status === "archived")
    .sort((a, b) => String(b.archivedAt || b.updatedAt || "").localeCompare(String(a.archivedAt || a.updatedAt || "")))
}


export function writeRegistry(registry) {
  const { file } = registryPath()
  writeJson(file, { ...registry, v: PROJECT_REGISTRY_VERSION, updatedAt: now() })
}

export function projectMetadataPath(project) {
  return path.join(project.dir, "project.json")
}

function projectRecordFromInfo(info, input = {}) {
  const name = input.name?.trim() || path.basename(info.root) || info.id
  const aliases = [...new Set([info.root, ...(input.aliases || [])].map((item) => path.resolve(item)))]
  return {
    v: PROJECT_REGISTRY_VERSION,
    id: info.id,
    name,
    root: info.root,
    dir: info.dir,
    worklog: info.log,
    aliases,
    status: input.status || "active",
    pinned: Boolean(input.pinned),
    createdAt: input.createdAt || now(),
    updatedAt: now(),
  }
}

export function ensureProject(workdir, input = {}) {
  const info = projectInfo(workdir)
  mkdirSync(info.dir, { recursive: true })
  const existing = readJson(projectMetadataPath(info), null)
  const project = {
    ...projectRecordFromInfo(info, { ...input, createdAt: existing?.createdAt }),
    ...(existing && typeof existing === "object" ? { ...existing, updatedAt: now() } : {}),
    ...(input.name ? { name: input.name } : {}),
    status: input.status || existing?.status || "active",
    pinned: input.pinned ?? existing?.pinned ?? false,
    aliases: [
      ...new Set([
        info.root,
        ...((existing?.aliases && Array.isArray(existing.aliases) ? existing.aliases : []) || []),
        ...((input.aliases && Array.isArray(input.aliases) ? input.aliases : []) || []),
      ].map((item) => path.resolve(item))),
    ],
  }

  writeJson(projectMetadataPath(info), project)
  const registry = readRegistry()
  registry.projects[project.id] = {
    id: project.id,
    name: project.name,
    root: project.root,
    dir: project.dir,
    aliases: project.aliases,
    status: project.status,
    pinned: project.pinned,
    archivedAt: project.archivedAt,
    updatedAt: project.updatedAt,
  }
  writeRegistry(registry)
  return project
}

function isWithin(candidate, root) {
  const rel = path.relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function resolveProject(workdir) {
  const cwd = path.resolve(workdir)
  const projects = Object.values(readRegistry().projects).filter((project) => (project.status || "active") === "active")
  const matches = projects
    .flatMap((project) => {
      const aliases = [project.root, ...(project.aliases || [])].filter(Boolean).map((item) => path.resolve(item))
      return aliases
        .filter((alias) => isWithin(cwd, alias))
        .map((alias) => ({ project, alias, score: alias.length }))
    })
    .sort((a, b) => b.score - a.score)
  if (matches[0]) return hydrateProject(matches[0].project.id) || matches[0].project
  return ensureProject(cwd)
}

function discoverProjectStreams(project) {
  const root = path.join(project.dir, "streams")
  if (!existsSync(root)) return []

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readStream(project, entry.name))
    .filter(Boolean)
}

export function resolveStreamByWorkdir(workdir) {
  const cwd = path.resolve(workdir)
  const projects = Object.values(readRegistry().projects).filter((project) => (project.status || "active") === "active")
  const matches = projects
    .flatMap((record) => {
      const project = hydrateProject(record.id) || record
      return listStreams(project, "active")
        .map((stream) => {
          const workspacePath = stream.workspace?.path ? path.resolve(stream.workspace.path) : undefined
          if (!workspacePath || !isWithin(cwd, workspacePath)) return undefined
          return { project, stream, score: workspacePath.length }
        })
        .filter(Boolean)
    })
    .sort((a, b) => b.score - a.score)
  if (!matches[0]) return undefined
  const best = matches.filter((match) => match.score === matches[0].score)
  return best.length === 1 ? best[0] : undefined
}

function sessionIndexPath(target) {
  return path.join(target.dir, "sessions.json")
}

function readSessionIndex(target) {
  const index = readJson(sessionIndexPath(target), { v: 1, sessions: {} })
  return {
    v: index.v || 1,
    lastSessionID: typeof index.lastSessionID === "string" ? index.lastSessionID : undefined,
    sessions: index.sessions && typeof index.sessions === "object" ? index.sessions : {},
  }
}

function newerSessionOwner(a, b) {
  if (!a) return b
  const aTime = String(a.entry?.updatedAt || a.entry?.createdAt || "")
  const bTime = String(b.entry?.updatedAt || b.entry?.createdAt || "")
  return bTime.localeCompare(aTime) > 0 ? b : a
}

export function resolveSessionOwner(sessionID) {
  if (!sessionID) return undefined
  const projects = Object.values(readRegistry().projects).filter((project) => (project.status || "active") === "active")
  let owner
  for (const record of projects) {
    const project = hydrateProject(record.id) || record
    const projectEntry = readSessionIndex(project).sessions[sessionID]
    if (projectEntry) owner = newerSessionOwner(owner, { scope: "project", project, entry: projectEntry })

    for (const stream of listStreams(project, "all")) {
      const streamEntry = readSessionIndex(stream).sessions[sessionID]
      if (streamEntry) owner = newerSessionOwner(owner, { scope: "stream", project, stream, entry: streamEntry })
    }
  }
  return owner
}

export function resolveStreamBySession(sessionID) {
  const owner = resolveSessionOwner(sessionID)
  if (owner?.scope === "stream") return { project: owner.project, stream: owner.stream }
  return undefined
}

export function hydrateProject(projectID) {
  const record = readRegistry().projects[projectID]
  if (!record) return undefined
  const metadata = readJson(path.join(record.dir, "project.json"), null)
  return metadata || record
}

function registryProjectRecord(project) {
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    dir: project.dir,
    aliases: project.aliases,
    status: project.status || "active",
    pinned: Boolean(project.pinned),
    archivedAt: project.archivedAt,
    updatedAt: project.updatedAt,
  }
}

export function updateProject(projectID, patch) {
  const project = hydrateProject(projectID)
  if (!project) throw new Error(`Project not found: ${projectID}`)
  const next = { ...project, ...patch, updatedAt: now() }
  writeJson(projectMetadataPath(next), next)
  const registry = readRegistry()
  registry.projects[next.id] = registryProjectRecord(next)
  writeRegistry(registry)
  return next
}

export function renameProject(projectID, name) {
  const nextName = name.trim()
  if (!nextName) throw new Error("Project name is required")
  return updateProject(projectID, { name: nextName })
}

export function setProjectPinned(projectID, pinned) {
  return updateProject(projectID, { pinned: Boolean(pinned) })
}

export function archiveProject(projectID) {
  const project = updateProject(projectID, { status: "archived", pinned: false, archivedAt: now() })
  const selection = readSelection()
  if (selection.projectID === projectID) writeSelection({ projectID: undefined, streamID: undefined })
  return project
}

export function restoreProject(projectID) {
  return updateProject(projectID, { status: "active", archivedAt: undefined })
}

export function deleteArchivedProject(projectID) {
  const project = hydrateProject(projectID)
  if (!project) throw new Error(`Project not found: ${projectID}`)
  if (project.status !== "archived") throw new Error("Only archived projects can be deleted permanently")

  const registry = readRegistry()
  delete registry.projects[projectID]
  writeRegistry(registry)
  if (project.dir) rmSync(project.dir, { recursive: true, force: true })

  const selection = readSelection()
  if (selection.projectID === projectID) writeSelection({ projectID: undefined, streamID: undefined })
}

export function streamID(name) {
  const base = slugify(name) || "stream"
  const hash = createHash("sha256").update(`${name}:${Date.now()}`).digest("hex").slice(0, 6)
  return `${base}--${hash}`
}

export function streamDir(project, id) {
  return path.join(project.dir, "streams", id)
}

export function streamMetadataPath(project, id) {
  return path.join(streamDir(project, id), "stream.json")
}

export function createStream(project, input) {
  const name = input.name.trim()
  const id = input.id || streamID(name)
  const dir = streamDir(project, id)
  mkdirSync(path.join(dir, "plans", "active"), { recursive: true })
  mkdirSync(path.join(dir, "plans", "archive"), { recursive: true })
  const stream = {
    v: STREAM_VERSION,
    id,
    projectID: project.id,
    name,
    purpose: input.purpose,
    status: "active",
    createdAt: now(),
    updatedAt: now(),
    dir,
    worklog: path.join(dir, "worklog.jsonl"),
    workspace: {
      mode: input.workspace?.mode || "shared-workdir",
      path: input.workspace?.path ? path.resolve(input.workspace.path) : project.root,
      branch: input.workspace?.branch,
      base: input.workspace?.base,
    },
  }
  writeJson(streamMetadataPath(project, id), stream)
  return stream
}

export function listStreams(project, status = "active") {
  const root = path.join(project.dir, "streams")
  if (!existsSync(root)) return []

  const index = readJson(path.join(root, ".index.json"), {})
  const indexed = Object.keys(index)
    .map((id) => readStream(project, id))
    .filter(Boolean)
  const discovered = discoverProjectStreams(project)
  const byID = new Map()

  for (const stream of indexed) {
    byID.set(stream.id, stream)
  }

  for (const stream of discovered) {
    if (!byID.has(stream.id)) {
      byID.set(stream.id, stream)
    }
  }

  return [...byID.values()]
    .filter((stream) => status === "all" || stream.status === status)
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
    })
}

export function readStream(project, id) {
  return readJson(streamMetadataPath(project, id), undefined)
}

export function updateStream(project, id, patch) {
  const stream = readStream(project, id)
  if (!stream) throw new Error(`Stream not found: ${id}`)
  const next = { ...stream, ...patch, updatedAt: now() }
  writeJson(streamMetadataPath(project, id), next)
  indexStream(project, next)
  return next
}

export function renameStream(project, id, name) {
  const nextName = name.trim()
  if (!nextName) throw new Error("Stream name is required")
  return updateStream(project, id, { name: nextName })
}

export function setStreamPinned(project, id, pinned) {
  return updateStream(project, id, { pinned: Boolean(pinned) })
}

export function archiveStream(project, id, patch = {}) {
  const stream = updateStream(project, id, { ...patch, status: "archived", pinned: false, archivedAt: now() })
  const selection = readSelection()
  if (selection.projectID === project.id && selection.streamID === id) clearStreamSelection()
  return stream
}

export function restoreStream(project, id) {
  return updateStream(project, id, { status: "active", archivedAt: undefined })
}

export function deleteArchivedStream(project, id) {
  const stream = readStream(project, id)
  if (!stream) throw new Error(`Stream not found: ${id}`)
  if (stream.status !== "archived") throw new Error("Only archived streams can be deleted permanently")

  const indexPath = path.join(project.dir, "streams", ".index.json")
  const index = readJson(indexPath, {})
  delete index[id]
  writeJson(indexPath, index)
  rmSync(stream.dir, { recursive: true, force: true })

  const selection = readSelection()
  if (selection.projectID === project.id && selection.streamID === id) clearStreamSelection()
}

export function selectionPath() {
  const dir = path.join(stateHome(), "opencode", "worklog")
  return { dir, file: path.join(dir, "selection.json") }
}

export function readSelection() {
  const { file } = selectionPath()
  return readJson(file, { projectID: undefined, streamID: undefined })
}

export function writeSelection(selection) {
  const { file } = selectionPath()
  writeJson(file, { ...selection, updatedAt: now() })
}

export function selectProject(projectID) {
  writeSelection({ projectID, streamID: undefined })
}

export function selectStream(projectID, id) {
  writeSelection({ projectID, streamID: id })
}

export function clearStreamSelection() {
  const current = readSelection()
  writeSelection({ projectID: current.projectID, streamID: undefined })
}

export function resolveContext(workdir, input = {}) {
  const sessionOwner = resolveSessionOwner(input.sessionID)
  if (sessionOwner?.scope === "stream") {
    return {
      scope: "stream",
      project: sessionOwner.project,
      stream: sessionOwner.stream,
      id: `${sessionOwner.project.id}/${sessionOwner.stream.id}`,
      root: sessionOwner.stream.workspace?.path || sessionOwner.project.root,
      dir: sessionOwner.stream.dir,
      log: sessionOwner.stream.worklog,
      plans: path.join(sessionOwner.stream.dir, "plans"),
    }
  }
  if (sessionOwner?.scope === "project") {
    return {
      scope: "project",
      project: sessionOwner.project,
      id: sessionOwner.project.id,
      root: sessionOwner.project.root,
      dir: sessionOwner.project.dir,
      log: sessionOwner.project.worklog,
      plans: path.join(sessionOwner.project.dir, "plans"),
    }
  }

  const matched = resolveStreamByWorkdir(workdir)
  if (matched?.stream) {
    return {
      scope: "stream",
      project: matched.project,
      stream: matched.stream,
      id: `${matched.project.id}/${matched.stream.id}`,
      root: matched.stream.workspace?.path || matched.project.root,
      dir: matched.stream.dir,
      log: matched.stream.worklog,
      plans: path.join(matched.stream.dir, "plans"),
    }
  }
  const project = resolveProject(workdir)
  return {
    scope: "project",
    project,
    id: project.id,
    root: project.root,
    dir: project.dir,
    log: project.worklog,
    plans: path.join(project.dir, "plans"),
  }
}

export function indexStream(project, stream) {
  const indexPath = path.join(project.dir, "streams", ".index.json")
  const index = readJson(indexPath, {})
  index[stream.id] = { id: stream.id, name: stream.name, status: stream.status, pinned: Boolean(stream.pinned), updatedAt: stream.updatedAt }
  writeJson(indexPath, index)
}

export function createIndexedStream(project, input) {
  const stream = createStream(project, input)
  indexStream(project, stream)
  return stream
}
