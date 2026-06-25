import { execFile, execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
  archiveProject,
  archiveStream,
  createIndexedStream,
  deleteArchivedProject,
  deleteArchivedStream,
  ensureProject,
  hydrateProject,
  listArchivedProjects,
  listProjects,
  listStreams,
  readStream,
  renameProject,
  renameStream,
  restoreProject,
  restoreStream,
  setProjectPinned,
  setStreamPinned,
  updateStream,
  resolveContext,
  resolveProject,
  resolveSessionOwner,
} from "./projects.js"
import { listPlans, resolveCurrentPlan } from "./plans.js"
import { ensureStore, readAllEntries } from "./worklog.js"
import { createSignal } from "solid-js"

export const id = "opencode-projects-tui"

const NEW_SESSION = "__new__"
const NEW_PROJECT = "__new_project__"
const NEW_STREAM = "__new_stream__"
const USE_PROJECT_DIRECTORY = "__use_project_directory__"
const TYPE_PROJECT_PATH = "__type_project_path__"
const BACK_TO_PROJECT_PICKER = "__back_to_project_picker__"
const PROJECT_WORKLOG = "__project__"
const BACK_PROJECTS = "__back_projects__"
const BACK_STREAMS = "__back_streams__"
const ARCHIVED_PROJECTS = "__archived_projects__"
const PROJECT_SHORTCUTS = "__project_shortcuts__"
const ARCHIVE_SHORTCUTS = "__archive_shortcuts__"
const WORKLOG_INFO = "__worklog_info__"
const ARCHIVED_STREAMS = "__archived_streams__"
const STREAM_SHORTCUTS = "__stream_shortcuts__"
const ARCHIVED_STREAM_SHORTCUTS = "__archived_stream_shortcuts__"
const SESSION_SHORTCUTS = "__session_shortcuts__"
const BACK_PLANS = "__back_plans__"
const PLAN_SHORTCUTS = "__plan_shortcuts__"
const CREATE_SHARED_STREAM = "__create_shared_stream__"
const CREATE_WORKTREE_STREAM = "__create_worktree_stream__"

let solidRuntime
let modalShortcuts
let sidebarVersion
let sidebarRefresh
const localSelection = { projectID: undefined, streamID: undefined }
const trackedToolCalls = new Map()
const sidebarRefreshTools = new Set(["plan_current", "plan_create", "plan_archive"])

function currentSelection() {
  return { ...localSelection }
}

function refreshSidebar(api) {
  if (sidebarRefresh) sidebarRefresh((value) => value + 1)
  api?.renderer?.requestRender?.()
}

function selectLocalProject(api, projectID) {
  localSelection.projectID = projectID
  localSelection.streamID = undefined
  refreshSidebar(api)
}

function selectLocalStream(api, projectID, streamID) {
  localSelection.projectID = projectID
  localSelection.streamID = streamID
  refreshSidebar(api)
}

function clearLocalStreamSelection(api) {
  localSelection.streamID = undefined
  refreshSidebar(api)
}

async function ensureSolidRuntime() {
  if (!solidRuntime) solidRuntime = await import("@opentui/solid")
  return solidRuntime
}

function selectedProject() {
  const selection = currentSelection()
  return selection.projectID ? hydrateProject(selection.projectID) : undefined
}

function activeProject(api) {
  if (api.route.current?.name === "session") return currentWorklogInfo(api).project
  return selectedProject() || resolveProject(api.state.path.directory)
}

function activeStream(project) {
  const selection = currentSelection()
  return selection.projectID === project.id && selection.streamID ? readStream(project, selection.streamID) : undefined
}

function contextLabels(api) {
  const sessionID = api.route.current?.name === "session" ? api.route.current.params?.sessionID : undefined
  const info = currentWorklogInfo(api)
  const project = info.project
  const stream = info.stream
  const session = sessionID ? api.state.session.get(sessionID) : undefined
  return {
    project: project.name || project.id,
    stream: stream?.name || "Project worklog",
    session: session ? sessionTitle(session) : sessionID || "None",
    workdir: formatHomePath(info.root || project.root || api.state.path.directory),
  }
}

function localContextInfo(api) {
  const selection = currentSelection()
  const selectedProject = selection.projectID ? hydrateProject(selection.projectID) : undefined
  const project = selectedProject || resolveProject(api.state.path.directory)
  const stream = selection.streamID && selection.projectID === project.id ? readStream(project, selection.streamID) : undefined
  if (stream) {
    return ensureStore({
      scope: "stream",
      project,
      stream,
      id: `${project.id}/${stream.id}`,
      root: stream.workspace?.path || project.root,
      dir: stream.dir,
      log: stream.worklog,
      plans: path.join(stream.dir, "plans"),
    })
  }
  return ensureStore({
    scope: "project",
    project,
    id: project.id,
    root: project.root,
    dir: project.dir,
    log: project.worklog,
    plans: path.join(project.dir, "plans"),
  })
}

function currentWorklogInfo(api) {
  const sessionID = api.route.current?.name === "session" ? api.route.current.params?.sessionID : undefined
  if (sessionID) return ensureStore(resolveContext(api.state.path.directory, { sessionID }))
  return localContextInfo(api)
}

function formatHomePath(value) {
  const home = homedir()
  if (!value || !home) return value || ""
  if (value === home) return "~"
  if (value.startsWith(`${home}/`)) return `~/${value.slice(home.length + 1)}`
  return value
}

function expandHomePath(value) {
  const trimmed = String(value || "").trim()
  if (!trimmed) return ""
  if (trimmed === "~") return homedir()
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2))
  return trimmed
}

function projectNameFromPath(projectPath) {
  return path.basename(path.resolve(projectPath)) || "Project"
}

function slugifyPathPart(input) {
  return String(input || "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 80) || "stream"
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function runGitAsync(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || "").trim()
        reject(new Error(detail || `git ${args.join(" ")} failed`))
        return
      }
      resolve(String(stdout || "").trim())
    })
  })
}

function gitRepoInfo(workdir) {
  try {
    const directory = path.resolve(workdir)
    const root = runGit(directory, ["rev-parse", "--show-toplevel"])
    if (!root) return undefined
    const commonDirRaw = runGit(root, ["rev-parse", "--git-common-dir"])
    const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(root, commonDirRaw)
    const branch = runGit(root, ["branch", "--show-current"]) || undefined
    return { root, commonDir, branch }
  } catch {
    return undefined
  }
}

function isGitProject(project) {
  return Boolean(gitRepoInfo(project.root))
}

function gitBranchExists(repoRoot, branch) {
  try {
    runGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

function uniqueWorktreePath(repoRoot, slug) {
  const base = path.join(repoRoot, ".worktrees", slug)
  if (!existsSync(base)) return base
  for (let index = 2; index < 1000; index++) {
    const candidate = path.join(repoRoot, ".worktrees", `${slug}-${index}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Could not find an available worktree path for ${slug}`)
}

function uniqueBranchName(repoRoot, slug) {
  const base = `stream/${slug}`
  if (!gitBranchExists(repoRoot, base)) return base
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base}-${index}`
    if (!gitBranchExists(repoRoot, candidate)) return candidate
  }
  throw new Error(`Could not find an available branch name for ${base}`)
}

function ensureWorktreesExcluded(commonDir) {
  const excludePath = path.join(commonDir, "info", "exclude")
  mkdirSync(path.dirname(excludePath), { recursive: true })
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
  if (existing.split(/\r?\n/).some((line) => line.trim() === ".worktrees/")) return
  const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
  appendFileSync(excludePath, `${prefix}.worktrees/\n`, "utf8")
}

function gitWorktreeWorkspaceForStream(project, name, mode = "pending-git-worktree") {
  const repo = gitRepoInfo(project.root)
  if (!repo) throw new Error("Project is not inside a git repository")
  const slug = slugifyPathPart(name)
  const worktreePath = uniqueWorktreePath(repo.root, slug)
  const branch = uniqueBranchName(repo.root, slug)
  const base = repo.branch || "HEAD"

  return {
    mode,
    path: worktreePath,
    branch,
    base,
    repoRoot: repo.root,
    gitCommonDir: repo.commonDir,
  }
}

async function createGitWorktree(workspace) {
  const repoRoot = workspace.repoRoot || gitRepoInfo(path.dirname(workspace.path))?.root
  const commonDir = workspace.gitCommonDir || (repoRoot ? gitRepoInfo(repoRoot)?.commonDir : undefined)
  if (!repoRoot || !commonDir) throw new Error("Could not resolve git repository for worktree")
  if (!workspace.path || !workspace.branch) throw new Error("Worktree path and branch are required")

  mkdirSync(path.dirname(workspace.path), { recursive: true })
  ensureWorktreesExcluded(commonDir)
  await runGitAsync(repoRoot, ["worktree", "add", "-b", workspace.branch, workspace.path, workspace.base || "HEAD"])
}

function isPendingWorktreeStream(stream) {
  return stream?.workspace?.mode === "pending-git-worktree"
}

function isGitWorktreeStream(stream) {
  return stream?.workspace?.mode === "git-worktree"
}

async function removeGitWorktree(workspace) {
  if (!workspace?.path) throw new Error("Worktree path is required")
  const repoRoot = workspace.repoRoot || gitRepoInfo(path.dirname(workspace.path))?.root
  if (!repoRoot) throw new Error("Could not resolve git repository for worktree")
  await runGitAsync(repoRoot, ["worktree", "remove", workspace.path])
}

function directoryOptions(currentPath) {
  const directory = path.resolve(currentPath || homedir())
  let children = []
  try {
    children = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        title: entry.name,
        value: path.join(directory, entry.name),
        description: formatHomePath(path.join(directory, entry.name)),
        category: entry.name.startsWith(".") ? "Hidden directories" : "Directories",
      }))
      .sort((a, b) => {
        const hidden = Number(a.title.startsWith(".")) - Number(b.title.startsWith("."))
        if (hidden) return hidden
        return a.title.localeCompare(b.title)
      })
  } catch {
    children = []
  }

  return [
    { title: "← Back to projects", value: BACK_TO_PROJECT_PICKER, category: "Navigation" },
    { title: "Use this directory", value: USE_PROJECT_DIRECTORY, description: formatHomePath(directory), category: "Actions" },
    { title: "Type path manually", value: TYPE_PROJECT_PATH, description: "Enter a path such as ~/matrix/web/argus", category: "Actions" },
    { title: "..", value: path.dirname(directory), description: formatHomePath(path.dirname(directory)), category: "Navigation" },
    ...children,
  ]
}

function projectDescription(project, selected) {
  const bits = []
  if (selected) bits.push("selected")
  if (project.pinned) bits.push("pinned")
  if (project.root) bits.push(formatHomePath(project.root))
  return bits.join(" · ")
}

function streamDescription(stream, selected) {
  const bits = []
  if (selected) bits.push("selected")
  if (stream.pinned) bits.push("pinned")
  if (stream.purpose) bits.push(stream.purpose)
  if (stream.workspace?.mode) bits.push(stream.workspace.mode)
  if (stream.workspace?.branch) bits.push(stream.workspace.branch)
  if (["git-worktree", "pending-git-worktree"].includes(stream.workspace?.mode) && stream.workspace?.path) bits.push(formatHomePath(stream.workspace.path))
  return bits.join(" · ")
}

function sessionTitle(session) {
  const title = session.title || session.slug || session.id
  if (/^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)) return "New session"
  if (/^Child session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)) return "Child session"
  return title
}

function sessionDescription() {
  return undefined
}

function currentPlanSummary(info) {
  const current = resolveCurrentPlan(info, "all")
  return current ? `${current.title} (${current.id})` : "none"
}

function readPlanContent(planPath) {
  if (!planPath) return undefined
  return readFileSync(planPath, "utf8")
}

function showPlanContentDialog(api, plan) {
  if (!plan) {
    api.ui.toast({ variant: "error", title: "Plan not found", message: "No plan selected." })
    return
  }

  let content
  try {
    content = readPlanContent(plan.path)
  } catch (error) {
    showError(api, "Failed to read plan", error)
    return
  }

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: `${plan.title} (${plan.id})`,
      message: [
        `Path: ${formatHomePath(plan.path)}`,
        "",
        content,
      ].join("\n"),
      onConfirm() {
        api.ui.dialog.clear()
        showPlanViewer(api)
      },
      onCancel() {
        api.ui.dialog.clear()
        showPlanViewer(api)
      },
    }),
  )
}

function showCurrentPlan(api) {
  const info = currentWorklogInfo(api)
  const plan = resolveCurrentPlan(info, "all")
  if (!plan) {
    api.ui.toast({ variant: "warning", title: "No current plan", message: "Set one with plan_current set." })
    return
  }
  api.ui.dialog.clear()
  showPlanContentDialog(api, plan)
}

function showPlanViewer(api) {
  const info = currentWorklogInfo(api)
  const plans = listPlans(info, "active")
  if (!plans.length) {
    api.ui.toast({ variant: "info", title: "No plans", message: "No active plans for this scope." })
    return
  }

  const current = resolveCurrentPlan(info, "all")
  const options = plans.map((plan) => {
    const isCurrent = current && plan.id === current.id
    return {
      title: isCurrent ? `${plan.title} (${plan.id}) [current]` : `${plan.title} (${plan.id})`,
      value: plan.path,
      description: `Updated: ${plan.updatedAt}`,
      category: "Plans",
    }
  })

  const state = {
    kind: "plans",
    plans,
    selected: options[0],
  }

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Plans · ${info.stream?.name || "Project worklog"}`,
      placeholder: plans.length ? "Search plans..." : "No plans",
      options: [
        { title: "← Back", value: BACK_PLANS, category: "Navigation" },
        { title: "Press Enter to view", value: PLAN_SHORTCUTS, category: "Shortcuts" },
        ...options,
      ],
      onMove(option) {
        state.selected = option
      },
      onSelect(option) {
        if (option.value === BACK_PLANS) {
          api.ui.dialog.clear()
          return
        }
        if (option.value === PLAN_SHORTCUTS) return
        const plan = plans.find((item) => item.path === option.value)
        api.ui.dialog.clear()
        showPlanContentDialog(api, plan)
      },
    }),
  )
}

function dateCategory(timestamp) {
  const updated = new Date(timestamp || 0)
  const today = new Date()
  if (updated.toDateString() === today.toDateString()) return "Today"
  return updated.toDateString()
}

function sessionCategory(session) {
  return dateCategory(session.time?.updated)
}

function newestSessionTimestamp(target) {
  const sessions = Object.values(readSessionIndex(target).sessions)
  return sessions.reduce((latest, session) => {
    const timestamp = String(session?.updatedAt || session?.createdAt || "")
    return timestamp.localeCompare(latest) > 0 ? timestamp : latest
  }, "")
}

function projectActivityTimestamp(project) {
  return [project, ...listStreams(project, "all")].reduce((latest, target) => {
    const timestamp = newestSessionTimestamp(target)
    return timestamp.localeCompare(latest) > 0 ? timestamp : latest
  }, String(project.updatedAt || project.createdAt || ""))
}

function streamActivityTimestamp(stream) {
  return newestSessionTimestamp(stream) || String(stream.updatedAt || stream.createdAt || "")
}

function compareActivity(a, b, activity) {
  const byActivity = String(activity(b) || "").localeCompare(String(activity(a) || ""))
  if (byActivity) return byActivity
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  const byName = String(a.name || a.id).localeCompare(String(b.name || b.id))
  if (byName) return byName
  return String(a.id).localeCompare(String(b.id))
}

function worklogContext(api) {
  return ensureStore(currentWorklogInfo(api))
}

function worklogTitle(info) {
  const project = info.project?.name || info.project?.id || info.id
  if (info.scope === "stream" && info.stream?.name) return `${project} · ${info.stream.name}`
  return `${project} · Project worklog`
}

function shortTime(timestamp) {
  if (!timestamp) return "No time"
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return String(timestamp)
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function truncate(value, length = 120) {
  const text = String(value || "")
  if (text.length <= length) return text
  return `${text.slice(0, length - 1)}…`
}

function entryTitle(entry) {
  const type = entry.type ? `${entry.type[0]?.toUpperCase() || ""}${entry.type.slice(1)}` : "Entry"
  return `${type}: ${entry.summary || entry.result || entry.next || "No summary"}`
}

function entryDescription(entry) {
  const bits = [shortTime(entry.time)]
  if (entry.task) bits.push(`task: ${entry.task}`)
  if (entry.next) bits.push(`next: ${truncate(entry.next, 80)}`)
  if (entry.blocker) bits.push(`blocker: ${truncate(entry.blocker, 80)}`)
  if (entry.result && !entry.next) bits.push(`result: ${truncate(entry.result, 80)}`)
  return bits.filter(Boolean).join(" · ")
}

function entryDetail(entry, info) {
  const lines = [
    `Project: ${info.project?.name || info.project?.id || info.id}`,
    `Stream: ${info.stream?.name || "Project worklog"}`,
    `Type: ${entry.type || "entry"}`,
    `Time: ${entry.time || "unknown"}`,
  ]
  if (entry.task) lines.push(`Task: ${entry.task}`)
  if (entry.summary) lines.push("", `Summary: ${entry.summary}`)
  if (entry.result) lines.push("", `Result: ${entry.result}`)
  if (entry.next) lines.push("", `Next: ${entry.next}`)
  if (entry.reason) lines.push("", `Reason: ${entry.reason}`)
  if (entry.lesson) lines.push("", `Lesson: ${entry.lesson}`)
  if (entry.blocker) lines.push("", `Blocker: ${entry.blocker}`)
  if (entry.files?.length) lines.push("", "Files:", ...entry.files.map((file) => `- ${formatHomePath(file)}`))
  return lines.join("\n")
}

function worklogOptions(info, entries) {
  return [
    {
      title: `${entries.length} entries · ${formatHomePath(info.log)}`,
      value: WORKLOG_INFO,
      category: "Info",
    },
    ...entries
      .map((entry, index) => ({ entry, index }))
      .toReversed()
      .map(({ entry, index }) => ({
        title: entryTitle(entry),
        value: String(index),
        description: entryDescription(entry),
        category: dateCategory(entry.time),
      })),
  ]
}

function showError(api, title, error) {
  api.ui.toast({
    variant: "error",
    title,
    message: error instanceof Error ? error.message : String(error),
  })
}

function showWorklogViewer(api) {
  try {
    const info = worklogContext(api)
    const entries = readAllEntries(info.log)
    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: `View worklog · ${worklogTitle(info)}`,
        placeholder: entries.length ? "Search worklog entries..." : "No worklog entries",
        options: worklogOptions(info, entries),
        onSelect(option) {
          if (option.value === WORKLOG_INFO) return
          const entry = entries[Number(option.value)]
          if (!entry) return
          api.ui.dialog.clear()
          showWorklogEntry(api, info, entries, entry)
        },
      }),
    )
  } catch (error) {
    api.ui.dialog.clear()
    showError(api, "Failed to open worklog", error)
  }
}

function showWorklogEntry(api, info, entries, entry) {
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: entryTitle(entry),
      message: entryDetail(entry, info),
      onConfirm() {
        api.ui.dialog.clear()
        showWorklogViewer(api)
      },
      onCancel() {
        api.ui.dialog.clear()
        showWorklogViewer(api)
      },
    }),
  )
}

function showWorklogContext(api) {
  const sessionID = api.route.current?.name === "session" ? api.route.current.params?.sessionID : undefined
  const info = currentWorklogInfo(api)
  const sessionSource = sessionID && info.stream ? "stream session index" : info.stream ? "selected stream" : "project"
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Project context",
      message: [
        `Project: ${info.project?.name || info.project?.id || info.id}`,
        `Stream: ${info.stream?.name || "Project worklog"}`,
        `Session: ${sessionID || "None"}`,
        `Scope: ${info.scope}`,
        `Source: ${sessionSource}`,
        `Workdir: ${formatHomePath(info.root)}`,
        ["git-worktree", "pending-git-worktree"].includes(info.stream?.workspace?.mode) ? `Branch: ${info.stream.workspace.branch || "unknown"}` : undefined,
        `Worklog: ${formatHomePath(info.log)}`,
        `Plans: ${formatHomePath(info.plans)}`,
      ].filter(Boolean).join("\n"),
      onConfirm() {
        api.ui.dialog.clear()
      },
      onCancel() {
        api.ui.dialog.clear()
      },
    }),
  )
}

function clearModalShortcuts() {
  if (modalShortcuts?.dispose) modalShortcuts.dispose()
  modalShortcuts = undefined
}

function setModalShortcuts(api, state) {
  clearModalShortcuts()
  modalShortcuts = {
    state,
    dispose: api.keymap.registerLayer({
      priority: 100,
      commands: [
        { name: "worklog.modal.pin", run: () => runModalShortcut(api, "pin") },
        { name: "worklog.modal.rename", run: () => runModalShortcut(api, "rename") },
        { name: "worklog.modal.delete", run: () => runModalShortcut(api, "delete") },
      ],
      bindings: [
        { key: "ctrl+f", cmd: "worklog.modal.pin" },
        { key: "ctrl+r", cmd: "worklog.modal.rename" },
        { key: "ctrl+d", cmd: "worklog.modal.delete" },
      ],
    }),
  }
}

function runModalShortcut(api, action) {
  const state = modalShortcuts?.state
  if (!state) return false
  if (state.kind === "projects") return runProjectShortcut(api, state, action)
  if (state.kind === "archived-projects") return runArchivedProjectShortcut(api, state, action)
  if (state.kind === "streams") return runStreamShortcut(api, state, action)
  if (state.kind === "archived-streams") return runArchivedStreamShortcut(api, state, action)
  if (state.kind === "sessions") return runSessionShortcut(api, state, action)
  return false
}

function selectedProjectFromState(state) {
  const value = state.selected?.value
  if (!value || value === ARCHIVED_PROJECTS || value === BACK_PROJECTS || value === NEW_PROJECT || value === PROJECT_SHORTCUTS || value === ARCHIVE_SHORTCUTS) return undefined
  return state.projects.find((project) => project.id === value)
}

function selectedStreamFromState(state) {
  const value = state.selected?.value
  if (!value || value === BACK_PROJECTS || value === BACK_STREAMS || value === PROJECT_WORKLOG || value === NEW_STREAM || value === ARCHIVED_STREAMS || value === STREAM_SHORTCUTS || value === ARCHIVED_STREAM_SHORTCUTS) return undefined
  return state.streams.find((stream) => stream.id === value)
}

function selectedSessionFromState(state) {
  const value = state.selected?.value
  if (!value || value === BACK_STREAMS || value === NEW_SESSION || value === SESSION_SHORTCUTS) return undefined
  return state.sessions.find((session) => session.id === value)
}

function runProjectShortcut(api, state, action) {
  const project = selectedProjectFromState(state)
  if (!project) return false

  if (action === "pin") {
    const next = setProjectPinned(project.id, !project.pinned)
    api.ui.toast({ variant: "success", title: next.pinned ? "Project pinned" : "Project unpinned", message: next.name || next.id })
    showProjectViewer(api, next.id)
    return true
  }

  if (action === "rename") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showRenameProjectPrompt(api, project)
    return true
  }

  if (action === "delete") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showArchiveProjectConfirm(api, project)
    return true
  }

  return false
}

function runArchivedProjectShortcut(api, state, action) {
  const project = selectedProjectFromState(state)
  if (!project) return false

  if (action === "rename") {
    try {
      const restored = restoreProject(project.id)
      api.ui.toast({ variant: "success", title: "Project restored", message: restored.name || restored.id })
      showArchivedProjectsViewer(api)
    } catch (error) {
      showError(api, "Failed to restore project", error)
    }
    return true
  }

  if (action === "delete") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showDeleteArchivedProjectConfirm(api, project)
    return true
  }

  return false
}

function runStreamShortcut(api, state, action) {
  const stream = selectedStreamFromState(state)
  if (!stream) return false

  if (action === "pin") {
    const next = setStreamPinned(state.project, stream.id, !stream.pinned)
    api.ui.toast({ variant: "success", title: next.pinned ? "Stream pinned" : "Stream unpinned", message: next.name || next.id })
    showStreamViewer(api, state.project)
    return true
  }

  if (action === "rename") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showRenameStreamPrompt(api, state.project, stream)
    return true
  }

  if (action === "delete") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showArchiveStreamConfirm(api, state.project, stream)
    return true
  }

  return false
}

function runArchivedStreamShortcut(api, state, action) {
  const stream = selectedStreamFromState(state)
  if (!stream) return false

  if (action === "rename") {
    try {
      const restored = restoreStream(state.project, stream.id)
      api.ui.toast({ variant: "success", title: "Stream restored", message: restored.name || restored.id })
      showArchivedStreamsViewer(api, state.project)
    } catch (error) {
      showError(api, "Failed to restore stream", error)
    }
    return true
  }

  if (action === "delete") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showDeleteArchivedStreamConfirm(api, state.project, stream)
    return true
  }

  return false
}

function runSessionShortcut(api, state, action) {
  const session = selectedSessionFromState(state)
  if (!session) return false

  if (action === "pin") {
    const pinned = !sessionIndexEntry(state.project, session.id)?.pinned
    setSessionPinned(state.project, session.id, pinned)
    api.ui.toast({ variant: "success", title: pinned ? "Session pinned" : "Session unpinned", message: sessionTitle(session) })
    showSessionViewer(api, state.project)
    return true
  }

  if (action === "rename") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showRenameSessionPrompt(api, state.project, session)
    return true
  }

  if (action === "delete") {
    clearModalShortcuts()
    api.ui.dialog.clear()
    showDeleteSessionConfirm(api, state.project, session)
    return true
  }

  return false
}

function sessionStream(project) {
  return activeStream(project)
}

function sessionDirectory(project, stream) {
  const workspacePath = stream?.workspace?.path || project.root
  return path.resolve(workspacePath)
}

function preserveSessionContext(api, project) {
  const stream = sessionStream(project)
  if (stream) selectLocalStream(api, project.id, stream.id)
  else selectLocalProject(api, project.id)
}

function followSessionOwner(api, owner) {
  if (!owner?.project) return false
  if (owner.scope === "stream" && owner.stream) selectLocalStream(api, owner.project.id, owner.stream.id)
  else selectLocalProject(api, owner.project.id)
  return true
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

function streamSessionIndexPath(stream) {
  return path.join(stream.dir, "sessions.json")
}

function projectSessionIndexPath(project) {
  return path.join(project.dir, "sessions.json")
}

function currentSessionIndexTarget(project) {
  return sessionStream(project) || project
}

function sessionIndexPath(target) {
  return target.projectID ? streamSessionIndexPath(target) : projectSessionIndexPath(target)
}

function readSessionIndex(target) {
  const index = readJson(sessionIndexPath(target), { v: 1, sessions: {} })
  return {
    v: index.v || 1,
    lastSessionID: typeof index.lastSessionID === "string" ? index.lastSessionID : undefined,
    sessions: index.sessions && typeof index.sessions === "object" ? index.sessions : {},
  }
}

function readStreamSessionIndex(stream) {
  return readSessionIndex(stream)
}

function writeSessionIndex(target, index) {
  writeJson(sessionIndexPath(target), index)
}

function recordSession(target, sessionID, patch = {}, options = {}) {
  if (!target || !sessionID) return
  const index = readSessionIndex(target)
  const existing = index.sessions[sessionID]
  index.sessions[sessionID] = {
    id: sessionID,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...existing,
    ...patch,
  }
  if (options.remember !== false) index.lastSessionID = sessionID
  writeSessionIndex(target, index)
}

function recordStreamSession(stream, sessionID) {
  recordSession(stream, sessionID)
}

function removeSessionRecord(project, sessionID) {
  for (const target of [project, ...listStreams(project, "all")]) {
    const index = readSessionIndex(target)
    if (!index.sessions[sessionID]) continue
    delete index.sessions[sessionID]
    if (index.lastSessionID === sessionID) delete index.lastSessionID
    writeSessionIndex(target, index)
  }
}

function sessionIndexEntry(project, sessionID) {
  const target = currentSessionIndexTarget(project)
  return readSessionIndex(target).sessions[sessionID]
}

function setSessionPinned(project, sessionID, pinned) {
  recordSession(currentSessionIndexTarget(project), sessionID, { pinned: Boolean(pinned) }, { remember: false })
}

function rememberedSessionID(project, sessions) {
  const lastSessionID = readSessionIndex(currentSessionIndexTarget(project)).lastSessionID
  if (lastSessionID && sessions.some((session) => session.id === lastSessionID)) return lastSessionID
  return undefined
}

function projectStreamSessionIDs(project) {
  const ids = new Set()
  for (const stream of listStreams(project, "active")) {
    for (const id of Object.keys(readStreamSessionIndex(stream).sessions)) ids.add(id)
  }
  return ids
}

async function listProjectRootSessions(api, project, limit = 100) {
  const stream = sessionStream(project)
  const directory = sessionDirectory(project, stream)
  if (!directory) throw new Error(`Project ${project.id} has no session directory`)
  if (isPendingWorktreeStream(stream) && !existsSync(directory)) return []
  const indexTarget = stream ? readStreamSessionIndex(stream) : readSessionIndex(project)
  const indexedSessionIDs = new Set(Object.keys(indexTarget.sessions))

  if (!indexedSessionIDs.size) return []

  const result = await api.client.session.list({
    directory,
    scope: "project",
    roots: true,
    limit,
  })

  const projectAssignedStreamSessionIDs = stream ? undefined : projectStreamSessionIDs(project)
  const sessions = (result.data ?? [])
    .filter((session) => !session.parentID)
    .filter((session) => indexedSessionIDs.has(session.id))
    .filter((session) => !projectAssignedStreamSessionIDs || !projectAssignedStreamSessionIDs.has(session.id))

  return sessions.toSorted((a, b) => {
    const aPinned = Boolean(sessionIndexEntry(project, a.id)?.pinned)
    const bPinned = Boolean(sessionIndexEntry(project, b.id)?.pinned)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    return (b.time?.updated || 0) - (a.time?.updated || 0)
  })
}

async function createProjectSession(api, project) {
  const stream = sessionStream(project)
  if (isPendingWorktreeStream(stream)) return createPendingWorktreeSession(api, project, stream)

  const directory = sessionDirectory(project, stream)
  if (!directory) throw new Error(`Project ${project.id} has no session directory`)
  const sessionID = (await api.client.session.create({ directory })).data?.id
  if (!sessionID) throw new Error("No session id returned")
  recordSession(currentSessionIndexTarget(project), sessionID)
  api.route.navigate("session", { sessionID })
  return sessionID
}

function showCreatingWorktreeDialog(api, stream) {
  const lines = [
    {
      title: "⠋ Creating worktree...",
      value: "loading",
      description: "This can take a bit for larger repos.",
      category: "Status",
      disabled: true,
    },
    {
      title: `Branch: ${stream.workspace.branch || "unknown"}`,
      value: "branch",
      category: "Details",
      disabled: true,
    },
    {
      title: `Path: ${formatHomePath(stream.workspace.path)}`,
      value: "path",
      category: "Details",
      disabled: true,
    },
  ]
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Creating worktree...",
      placeholder: "Please wait...",
      options: lines,
      onSelect() {},
    }),
  )
}

async function createPendingWorktreeSession(api, project, stream) {
  showCreatingWorktreeDialog(api, stream)
  await createGitWorktree(stream.workspace)
  const nextWorkspace = { ...stream.workspace, mode: "git-worktree" }
  const updatedStream = updateStream(project, stream.id, { workspace: nextWorkspace })
  selectLocalStream(api, project.id, updatedStream.id)

  const sessionID = (await api.client.session.create({ directory: updatedStream.workspace.path })).data?.id
  if (!sessionID) throw new Error("No session id returned")
  recordSession(updatedStream, sessionID)
  api.ui.toast({
    variant: "success",
    title: "Worktree session created",
    message: `${updatedStream.name} · ${formatHomePath(updatedStream.workspace.path)}`,
  })
  api.route.navigate("session", { sessionID })
  return sessionID
}

async function createProjectSessionFromPalette(api) {
  const project = activeProject(api)
  try {
    await createProjectSession(api, project)
    preserveSessionContext(api, project)
    api.ui.dialog.clear()
  } catch (error) {
    showError(api, "Failed to create session", error)
  }
}

function showProjectViewer(api, currentProjectID) {
  const currentProject = resolveProject(api.state.path.directory)
  const selection = currentSelection()
  const projects = listProjects().toSorted((a, b) => compareActivity(a, b, projectActivityTimestamp))
  const options = [
    {
      title: "ctrl+f pin/unpin · ctrl+r rename · ctrl+d archive",
      value: PROJECT_SHORTCUTS,
      category: "Shortcuts",
    },
    { title: "Archived projects", value: ARCHIVED_PROJECTS, category: "Navigation" },
    { title: "New project", value: NEW_PROJECT, description: "Create from a local path", category: "Projects" },
    ...projects.map((project) => ({
      title: project.name || project.id,
      value: project.id,
      description: projectDescription(project, selection.projectID === project.id),
      category: "Projects",
    })),
  ]

  if (!projects.some((project) => project.id === currentProject.id)) {
    options.unshift({
      title: currentProject.name || currentProject.id,
      value: currentProject.id,
      description: projectDescription(currentProject, selection.projectID === currentProject.id),
      category: "Projects",
    })
  }

  const state = {
    kind: "projects",
    projects: options
      .map((option) => listProjects().find((project) => project.id === option.value) || (option.value === currentProject.id ? currentProject : undefined))
      .filter(Boolean),
    selected: options.find((option) => option.value === (currentProjectID || selection.projectID)) || options[0],
  }
  setModalShortcuts(api, state)

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Open Projects · Project",
      placeholder: "Search projects...",
      options,
      current: currentProjectID || selection.projectID,
      onMove(option) {
        state.selected = option
      },
      onSelect(option) {
        clearModalShortcuts()
        if (option.value === ARCHIVED_PROJECTS) {
          api.ui.dialog.clear()
          showArchivedProjectsViewer(api)
          return
        }

        if (option.value === NEW_PROJECT) {
          api.ui.dialog.clear()
          showCreateProjectDirectoryPicker(api)
          return
        }

        if (option.value === PROJECT_SHORTCUTS) return

        const project = listProjects().find((item) => item.id === option.value) || currentProject
        selectLocalProject(api, project.id)
        api.ui.dialog.clear()
        showStreamViewer(api, project)
      },
    }),
    () => clearModalShortcuts(),
  )
}

function createProjectFromPath(api, projectPath) {
  if (!existsSync(projectPath)) throw new Error(`Path does not exist: ${formatHomePath(projectPath)}`)
  if (!statSync(projectPath).isDirectory()) throw new Error(`Path is not a directory: ${formatHomePath(projectPath)}`)
  const project = ensureProject(projectPath, { name: projectNameFromPath(projectPath) })
  selectLocalProject(api, project.id)
  api.ui.toast({ variant: "success", title: "Project created", message: project.name || project.id })
  api.ui.dialog.clear()
  showStreamViewer(api, project)
}

function showCreateProjectDirectoryPicker(api, currentPath = api.state.path.directory || homedir()) {
  const directory = path.resolve(currentPath)
  const options = directoryOptions(directory)

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `New project · ${formatHomePath(directory)}`,
      placeholder: "Search directories...",
      options,
      current: USE_PROJECT_DIRECTORY,
      onSelect(option) {
        if (option.value === BACK_TO_PROJECT_PICKER) {
          api.ui.dialog.clear()
          showProjectViewer(api)
          return
        }

        if (option.value === TYPE_PROJECT_PATH) {
          api.ui.dialog.clear()
          showCreateProjectPrompt(api, directory)
          return
        }

        if (option.value === USE_PROJECT_DIRECTORY) {
          try {
            createProjectFromPath(api, directory)
          } catch (error) {
            api.ui.dialog.clear()
            showError(api, "Failed to create project", error)
            showCreateProjectDirectoryPicker(api, directory)
          }
          return
        }

        api.ui.dialog.clear()
        showCreateProjectDirectoryPicker(api, option.value)
      },
    }),
  )
}

function showCreateProjectPrompt(api, currentPath = api.state.path.directory || homedir()) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "New project",
      placeholder: formatHomePath(currentPath) || "~/matrix/web/argus",
      onConfirm(value) {
        const rawPath = expandHomePath(value)
        if (!rawPath) {
          api.ui.toast({ variant: "error", title: "Project path required", message: "Enter a local directory path." })
          return
        }
        const projectPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(currentPath, rawPath)

        try {
          createProjectFromPath(api, projectPath)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to create project", error)
          showCreateProjectDirectoryPicker(api, path.dirname(projectPath))
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showCreateProjectDirectoryPicker(api, currentPath)
      },
    }),
  )
}

function showRenameProjectPrompt(api, project) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Rename project",
      placeholder: project.name || project.id,
      value: project.name || "",
      onConfirm(value) {
        try {
          const next = renameProject(project.id, value)
          api.ui.dialog.clear()
          showProjectViewer(api, next.id)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to rename project", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showProjectViewer(api, project.id)
      },
    }),
  )
}

function showArchiveProjectConfirm(api, project) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Archive project",
      message: `Archive project "${project.name || project.id}"? Worklogs, plans, and streams will be kept locally.`,
      onConfirm() {
        try {
          archiveProject(project.id)
          const selection = currentSelection()
          if (selection.projectID === project.id) clearLocalStreamSelection(api)
          api.ui.dialog.clear()
          showProjectViewer(api)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to archive project", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showProjectViewer(api, project.id)
      },
    }),
  )
}

function showArchivedProjectsViewer(api) {
  const archived = listArchivedProjects()
  const options = [
    { title: "← Back to projects", value: BACK_PROJECTS, category: "Navigation" },
    {
      title: "ctrl+r restore · ctrl+d delete permanently",
      value: ARCHIVE_SHORTCUTS,
      category: "Shortcuts",
    },
    ...archived.map((project) => ({
      title: project.name || project.id,
      value: project.id,
      description: project.root ? formatHomePath(project.root) : undefined,
      category: project.archivedAt ? dateCategory(project.archivedAt) : "Archived",
    })),
    {
      title: "ctrl+r restore · ctrl+d delete permanently",
      value: "__archive_shortcuts__",
      category: "Shortcuts",
      disabled: true,
    },
  ]
  const state = {
    kind: "archived-projects",
    projects: archived,
    selected: options[0],
  }
  setModalShortcuts(api, state)

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Archived projects",
      placeholder: archived.length ? "Search archived projects..." : "No archived projects",
      options,
      onMove(option) {
        state.selected = option
      },
      onSelect(option) {
        clearModalShortcuts()
        if (option.value === BACK_PROJECTS) {
          api.ui.dialog.clear()
          showProjectViewer(api)
          return
        }

        if (option.value === ARCHIVE_SHORTCUTS) return

        if (option.value === ARCHIVE_SHORTCUTS) return
      },
    }),
    () => clearModalShortcuts(),
  )
}

function showDeleteArchivedProjectConfirm(api, project) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Delete archived project permanently",
      message: [
        `Delete archived project "${project.name || project.id}" permanently?`,
        "This deletes local worklog data only. It will not delete the code repository.",
      ].join("\n"),
      onConfirm() {
        try {
          deleteArchivedProject(project.id)
          api.ui.dialog.clear()
          showArchivedProjectsViewer(api)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to delete archived project", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showArchivedProjectsViewer(api)
      },
    }),
  )
}

function showRenameStreamPrompt(api, project, stream) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Rename stream",
      placeholder: stream.name || stream.id,
      value: stream.name || "",
      onConfirm(value) {
        try {
          renameStream(project, stream.id, value)
          api.ui.dialog.clear()
          showStreamViewer(api, project)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to rename stream", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showStreamViewer(api, project)
      },
    }),
  )
}

function showArchiveStreamConfirm(api, project, stream) {
  const worktree = isGitWorktreeStream(stream) ? stream.workspace : undefined
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Archive stream",
      message: worktree
        ? [
          `Archive stream "${stream.name || stream.id}"?`,
          "",
          "This will remove the git worktree checkout:",
          formatHomePath(worktree.path),
          "",
          `The stream worklog, plans, sessions, and branch ${worktree.branch || "unknown"} will be kept.`,
          "If the worktree has uncommitted changes, archive will fail safely.",
        ].join("\n")
        : `Archive stream "${stream.name || stream.id}"? Worklogs, plans, and stream sessions will be kept locally.`,
      async onConfirm() {
        try {
          if (worktree) await removeGitWorktree(worktree)
          const workspace = worktree ? { ...worktree, removedAt: new Date().toISOString(), removeReason: "archived" } : stream.workspace
          archiveStream(project, stream.id, workspace ? { workspace } : undefined)
          api.ui.dialog.clear()
          api.ui.toast({ variant: "success", title: "Stream archived", message: stream.name || stream.id })
          showStreamViewer(api, project)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, worktree ? "Failed to remove worktree" : "Failed to archive stream", error)
          showStreamViewer(api, project)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showStreamViewer(api, project)
      },
    }),
  )
}

function showArchivedStreamsViewer(api, project) {
  const archived = listStreams(project, "archived")
  const options = [
    { title: "← Back to streams", value: BACK_STREAMS, category: "Navigation" },
    { title: "ctrl+r restore · ctrl+d delete permanently", value: ARCHIVED_STREAM_SHORTCUTS, category: "Shortcuts" },
    ...archived.map((stream) => ({
      title: stream.name || stream.id,
      value: stream.id,
      description: stream.purpose,
      category: stream.archivedAt ? dateCategory(stream.archivedAt) : "Archived",
    })),
  ]
  const state = { kind: "archived-streams", project, streams: archived, selected: options[0] }
  setModalShortcuts(api, state)

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Archived streams · ${project.name || project.id}`,
      placeholder: archived.length ? "Search archived streams..." : "No archived streams",
      options,
      onMove(option) {
        state.selected = option
      },
      onSelect(option) {
        clearModalShortcuts()
        if (option.value === BACK_STREAMS) {
          api.ui.dialog.clear()
          showStreamViewer(api, project)
        }
      },
    }),
    () => clearModalShortcuts(),
  )
}

function showDeleteArchivedStreamConfirm(api, project, stream) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Delete archived stream permanently",
      message: [
        `Delete archived stream "${stream.name || stream.id}" permanently?`,
        "This deletes local stream worklog, plans, and session index data only. It will not delete code or opencode sessions.",
      ].join("\n"),
      onConfirm() {
        try {
          deleteArchivedStream(project, stream.id)
          api.ui.dialog.clear()
          showArchivedStreamsViewer(api, project)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to delete archived stream", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showArchivedStreamsViewer(api, project)
      },
    }),
  )
}

function showStreamViewer(api, project) {
  const selection = currentSelection()
  const streams = listStreams(project, "active").toSorted((a, b) => compareActivity(a, b, streamActivityTimestamp))
  const options = [
    { title: "← Back to projects", value: BACK_PROJECTS, category: "Navigation" },
    { title: "ctrl+f pin/unpin · ctrl+r rename · ctrl+d archive", value: STREAM_SHORTCUTS, category: "Shortcuts" },
    { title: "Archived streams", value: ARCHIVED_STREAMS, category: "Navigation" },
    { title: "Project worklog", value: PROJECT_WORKLOG, description: "No stream", category: "Streams" },
    { title: "New stream", value: NEW_STREAM, description: "Create and select a stream", category: "Streams" },
    ...streams.map((stream) => ({
      title: stream.name || stream.id,
      value: stream.id,
      description: streamDescription(stream, selection.streamID === stream.id),
      category: "Streams",
    })),
  ]
  const state = { kind: "streams", project, streams, selected: options[0] }
  setModalShortcuts(api, state)

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Open Projects · Stream · ${project.name || project.id}`,
      placeholder: "Search streams...",
      options,
      current: selection.streamID || PROJECT_WORKLOG,
      onMove(option) {
        state.selected = option
      },
      onSelect(option) {
        clearModalShortcuts()
        if (option.value === BACK_PROJECTS) {
          api.ui.dialog.clear()
          showProjectViewer(api)
          return
        }

        if (option.value === STREAM_SHORTCUTS) return

        if (option.value === ARCHIVED_STREAMS) {
          api.ui.dialog.clear()
          showArchivedStreamsViewer(api, project)
          return
        }

        if (option.value === PROJECT_WORKLOG) {
          clearLocalStreamSelection(api)
          selectLocalProject(api, project.id)
          api.ui.dialog.clear()
          showSessionViewer(api, project)
          return
        }

        if (option.value === NEW_STREAM) {
          api.ui.dialog.clear()
          showCreateStreamPrompt(api, project)
          return
        }

        selectLocalStream(api, project.id, option.value)
        api.ui.dialog.clear()
        showSessionViewer(api, project)
      },
    }),
    () => clearModalShortcuts(),
  )
}

function showCreateStreamPrompt(api, project) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: `New stream · ${project.name || project.id}`,
      placeholder: "Stream name",
      onConfirm(value) {
        const name = value.trim()
        if (!name) {
          api.ui.toast({ variant: "error", title: "Stream name required", message: "Enter a stream name." })
          return
        }

        if (isGitProject(project)) showCreateStreamWorkspaceChoice(api, project, name)
        else createAndOpenStream(api, project, { name })
      },
      onCancel() {
        api.ui.dialog.clear()
        showStreamViewer(api, project)
      },
    }),
  )
}

function createAndOpenStream(api, project, input) {
  try {
    const stream = createIndexedStream(project, input)
    selectLocalStream(api, project.id, stream.id)
    const worktreeStream = ["git-worktree", "pending-git-worktree"].includes(input.workspace?.mode)
    if (!worktreeStream || input.workspace?.mode === "git-worktree") {
      api.ui.toast({
        variant: "success",
        title: worktreeStream ? "Worktree stream created" : "Stream created",
        message: worktreeStream ? `${stream.name} · ${formatHomePath(stream.workspace.path)}` : stream.name,
      })
    }
    api.ui.dialog.clear()
    showSessionViewer(api, project)
  } catch (error) {
    api.ui.dialog.clear()
    showError(api, "Failed to create stream", error)
    showStreamViewer(api, project)
  }
}

function showCreateStreamWorkspaceChoice(api, project, name) {
  const repo = gitRepoInfo(project.root)
  if (!repo) {
    createAndOpenStream(api, project, { name })
    return
  }

  const slug = slugifyPathPart(name)
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "Create a new worktree?",
      placeholder: "Yes or no...",
      options: [
        {
          title: "Yes",
          value: CREATE_WORKTREE_STREAM,
          description: `${formatHomePath(path.join(repo.root, ".worktrees", slug))} · stream/${slug}`,
          category: "Workspace",
        },
        {
          title: "No",
          value: CREATE_SHARED_STREAM,
          description: formatHomePath(project.root),
          category: "Workspace",
        },
      ],
      current: CREATE_WORKTREE_STREAM,
      onSelect(option) {
        if (option.value === CREATE_SHARED_STREAM) {
          createAndOpenStream(api, project, { name })
          return
        }

        if (option.value === CREATE_WORKTREE_STREAM) {
          try {
            const workspace = gitWorktreeWorkspaceForStream(project, name)
            createAndOpenStream(api, project, { name, workspace })
          } catch (error) {
            api.ui.dialog.clear()
            showError(api, "Failed to prepare worktree", error)
            showStreamViewer(api, project)
          }
        }
      },
    }),
  )
}

function sessionOptions(sessions, project) {
  const directory = sessionDirectory(project, sessionStream(project))
  return [
    { title: "← Back to streams", value: BACK_STREAMS, category: "Navigation" },
    { title: "ctrl+f pin/unpin · ctrl+r rename · ctrl+d delete", value: SESSION_SHORTCUTS, category: "Shortcuts" },
    { title: "New session", value: NEW_SESSION, description: formatHomePath(directory), category: "Sessions" },
    ...sessions.map((session) => ({
      title: sessionTitle(session),
      value: session.id,
      description: sessionDescription(session),
      category: sessionIndexEntry(project, session.id)?.pinned ? "Pinned" : sessionCategory(session),
    })),
  ]
}

function showSessionViewer(api, project) {
  const initialOptions = sessionOptions([], project)
  const initialState = { kind: "sessions", project, sessions: [], selected: initialOptions[0] }
  setModalShortcuts(api, initialState)
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: `Open Projects · Session · ${project.name || project.id}`,
      placeholder: "Search sessions...",
      options: initialOptions,
      onMove(option) {
        initialState.selected = option
      },
      async onSelect(option) {
        clearModalShortcuts()
        await openSessionOption(api, project, option)
      },
    }),
    () => clearModalShortcuts(),
  )

  listProjectRootSessions(api, project)
    .then((sessions) => {
      const options = sessionOptions(sessions, project)
      const state = { kind: "sessions", project, sessions, selected: options[0] }
      setModalShortcuts(api, state)
      api.ui.dialog.replace(() =>
        api.ui.DialogSelect({
          title: `Open Projects · Session · ${project.name || project.id}`,
          placeholder: "Search sessions...",
          options,
          current: api.route.current?.name === "session" ? api.route.current.params?.sessionID : rememberedSessionID(project, sessions),
          onMove(option) {
            state.selected = option
          },
          async onSelect(option) {
            clearModalShortcuts()
            await openSessionOption(api, project, option)
          },
        }),
        () => clearModalShortcuts(),
      )
    })
    .catch((error) => {
      showError(api, "Failed to list sessions", error)
    })
}

function showRenameSessionPrompt(api, project, session) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogPrompt({
      title: "Rename session",
      placeholder: sessionTitle(session),
      value: sessionTitle(session),
      async onConfirm(value) {
        const title = value.trim()
        if (!title) {
          api.ui.toast({ variant: "error", title: "Session title required", message: "Enter a session title." })
          return
        }
        try {
          await api.client.session.update({ sessionID: session.id, title })
          recordSession(currentSessionIndexTarget(project), session.id, { title })
          api.ui.dialog.clear()
          showSessionViewer(api, project)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to rename session", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showSessionViewer(api, project)
      },
    }),
  )
}

function showDeleteSessionConfirm(api, project, session) {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogConfirm({
      title: "Delete session permanently",
      message: [
        `Delete session "${sessionTitle(session)}" permanently?`,
        "This deletes the opencode session and removes it from worklog stream indexes. It does not archive.",
      ].join("\n"),
      async onConfirm() {
        try {
          if (api.client.session.remove) await api.client.session.remove({ sessionID: session.id })
          else await api.client.session.delete({ sessionID: session.id })
          removeSessionRecord(project, session.id)
          api.ui.dialog.clear()
          showSessionViewer(api, project)
        } catch (error) {
          api.ui.dialog.clear()
          showError(api, "Failed to delete session", error)
        }
      },
      onCancel() {
        api.ui.dialog.clear()
        showSessionViewer(api, project)
      },
    }),
  )
}

async function openSessionOption(api, project, option) {
  try {
    if (option.value === BACK_STREAMS) {
      api.ui.dialog.clear()
      showStreamViewer(api, project)
      return
    }

    if (option.value === SESSION_SHORTCUTS) return

    if (option.value === NEW_SESSION) {
      await createProjectSession(api, project)
      preserveSessionContext(api, project)
    } else {
      const owner = resolveSessionOwner(option.value)
      if (owner) followSessionOwner(api, owner)
      else {
        recordSession(currentSessionIndexTarget(project), option.value)
        preserveSessionContext(api, project)
      }
      api.route.navigate("session", { sessionID: option.value })
    }
    api.ui.dialog.clear()
  } catch (error) {
    api.ui.dialog.clear()
    showError(api, "Failed to open session", error)
    showSessionViewer(api, project)
  }
}

function textLine(runtime, text, props = {}) {
  const { createElement, insert, setProp } = runtime
  const line = createElement("text")
  if (props.fg) setProp(line, "fg", props.fg)
  if (props.bold) setProp(line, "bold", true)
  insert(line, text)
  return line
}

function labelLine(runtime, label, value, theme) {
  const { createElement, insert, setProp } = runtime
  const line = createElement("text")
  const key = createElement("span")
  const text = createElement("span")
  setProp(key, "style", { fg: theme.text, bold: true })
  setProp(text, "style", { fg: theme.textMuted })
  insert(key, `${label}: `)
  insert(text, value)
  insert(line, key)
  insert(line, text)
  return line
}

function worklogStatusLine(runtime, info, theme) {
  const { createElement, insert, setProp } = runtime
  const line = createElement("text")
  const dot = createElement("span")
  const name = createElement("span")
  const status = createElement("span")
  const loaded = Boolean(info?.log && existsSync(info.log))
  setProp(dot, "style", { fg: loaded ? theme.success : theme.error })
  setProp(name, "style", { fg: theme.textMuted, bold: true })
  setProp(status, "style", { fg: theme.textMuted })
  insert(dot, "•")
  insert(name, " Worklog")
  insert(status, loaded ? " loaded" : " unavailable")
  insert(line, dot)
  insert(line, name)
  insert(line, status)
  return line
}

function sidebarContextView(api, runtime) {
  sidebarVersion?.()
  const { createElement, insert, setProp } = runtime
  const theme = api.theme.current
  const labels = contextLabels(api)
  const info = currentWorklogInfo(api)
  const box = createElement("box")
  setProp(box, "flexDirection", "column")
  setProp(box, "gap", 0)
  insert(box, labelLine(runtime, "Project", labels.project, theme))
  insert(box, labelLine(runtime, "Stream", labels.stream, theme))
  insert(box, labelLine(runtime, "Current plan", currentPlanSummary(info), theme))
  insert(box, labelLine(runtime, "Session", labels.session, theme))
  insert(box, labelLine(runtime, "Workdir", labels.workdir, theme))
  insert(box, worklogStatusLine(runtime, info, theme))
  return box
}

function homeContextView(api, runtime) {
  const { createElement, insert, setProp } = runtime
  const theme = api.theme.current
  const info = currentWorklogInfo(api)
  const target = info.stream || info.project
  const lastSessionID = target ? readSessionIndex(target).lastSessionID : undefined
  const lastSession = lastSessionID ? api.state.session.get(lastSessionID) : undefined
  const box = createElement("box")
  setProp(box, "flexDirection", "column")
  setProp(box, "gap", 0)
  setProp(box, "marginTop", 1)
  insert(box, textLine(runtime, "Project Context", { fg: theme.textMuted, bold: true }))
  insert(box, labelLine(runtime, "Project", info.project?.name || info.project?.id || info.id, theme))
  insert(box, labelLine(runtime, "Stream", info.stream?.name || "Project worklog", theme))
  insert(box, labelLine(runtime, "Current plan", currentPlanSummary(info), theme))
  insert(box, labelLine(runtime, "Workdir", formatHomePath(info.root), theme))
  insert(box, labelLine(runtime, "Last Session", lastSession ? sessionTitle(lastSession) : lastSessionID || "None", theme))
  return box
}

async function registerSidebarContext(api) {
  if (!api.slots?.register) return
  const runtime = await ensureSolidRuntime()
  const [getSidebarVersion, setSidebarVersion] = createSignal(0)
  sidebarVersion = getSidebarVersion
  sidebarRefresh = setSidebarVersion
  api.slots.register({
    order: 80,
    slots: {
      sidebar_content() {
        return sidebarContextView(api, runtime)
      },
      home_bottom() {
        return homeContextView(api, runtime)
      },
    },
  })
}

function registerSidebarRefreshEvents(api) {
  const disposers = []
  if (api.event?.on) {
    disposers.push(api.event.on("session.next.tool.called", (event) => {
      const tool = event.properties?.tool
      if (sidebarRefreshTools.has(tool)) trackedToolCalls.set(event.properties.callID, tool)
    }))
    disposers.push(api.event.on("session.next.tool.success", (event) => {
      if (!trackedToolCalls.has(event.properties?.callID)) return
      trackedToolCalls.delete(event.properties.callID)
      refreshSidebar(api)
    }))
    disposers.push(api.event.on("session.next.tool.failed", (event) => {
      trackedToolCalls.delete(event.properties?.callID)
    }))
  }
  api.lifecycle?.onDispose?.(() => {
    for (const dispose of disposers) dispose?.()
  })
}

export async function tui(api) {
  await registerSidebarContext(api)
  registerSidebarRefreshEvents(api)

  const projectCommands = [
    "projects.open",
    "projects.stream.open",
    "projects.session.open",
    "projects.session.new",
    "projects.worklog.view",
    "projects.context.view",
    "projects.plans.view",
    "projects.plans.current",
  ]

  api.keymap.registerLayer({
    commands: [
      {
        name: "projects.open",
        title: "Open Projects",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          showProjectViewer(api)
        },
      },
      {
        name: "projects.stream.open",
        title: "Open Streams",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          const project = activeProject(api)
          showStreamViewer(api, project)
        },
      },
      {
        name: "projects.session.open",
        title: "Open Sessions",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          const project = activeProject(api)
          showSessionViewer(api, project)
        },
      },
      {
        name: "projects.session.new",
        title: "New Project Session",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          createProjectSessionFromPalette(api)
        },
      },
      {
        name: "projects.worklog.view",
        title: "View Worklog",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          showWorklogViewer(api)
        },
      },
      {
        name: "projects.context.view",
        title: "Project Context",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          showWorklogContext(api)
        },
      },
      {
        name: "projects.plans.view",
        title: "View Plans",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          showPlanViewer(api)
        },
      },
      {
        name: "projects.plans.current",
        title: "View Current Plan",
        category: "OpenCode Projects",
        namespace: "palette",
        run() {
          showCurrentPlan(api)
        },
      },
    ],
    bindings: [
      ...api.tuiConfig.keybinds.gather("projects", projectCommands),
      { key: "<leader>p", cmd: "projects.open" },
      { key: "<leader>s", cmd: "projects.stream.open" },
      { key: "<leader>l", cmd: "projects.session.open" },
      { key: "<leader>n", cmd: "projects.session.new" },
    ],
  })
}

export default {
  id,
  tui,
}
