# opencode-worklog

OpenCode server and TUI plugin for project worklog tracking, durable plan artifacts, and explicit streams.

## What it provides

- `worklog_append` tool for concise project progress, decision, blocker, and finish entries.
- Durable project plan tools: `plan_create`, `plan_list`, `plan_read`, `plan_update`, and `plan_archive`.
- Plan-aware context injection when the user asks to plan, resume, continue, execute, or archive a plan.
- Additive TUI palette commands for opening registered projects, viewing worklogs, opening project-scoped sessions, creating project sessions, and managing streams.
- A small reminder while tracking is enabled so the assistant appends meaningful updates and can read deeper history only when needed.

## Storage model

Worklogs and plans are scoped by the selected worklog project or stream. If no project has been selected in the TUI, the plugin falls back to the current working directory. Data is stored locally outside the git repo:

```text
~/.local/share/opencode/project-logs/<project-id>/
  worklog.jsonl
  project.json
  plans/
    active/
    archive/
  streams/
    <stream-id>/
      stream.json
      worklog.jsonl
      plans/
```

The intended split is:

- Plan = intended route.
- Worklog = durable progress, decisions, blockers, detours, mistakes, next steps, and completion events.
- `todowrite` = live checklist for the current opencode session.

Do not edit a plan just to mark checklist progress. Use the opencode todo list for live session tracking and worklog entries for durable progress. Update a plan only when the intended approach, scope, constraints, risks, or completion criteria change.

## Plan workflow

Use `plan_create` to create a detailed active plan. The plan body should be thorough markdown covering goal, context, recommended approach, phases, risks, completion criteria, and handoff notes.

When a user asks to resume, continue, execute, or archive a plan, the plugin injects a small hidden context packet with active plan paths and recent worklog entries for the active plan when there is exactly one.

Use `plan_read` before acting on a plan. Use `worklog_append` with the `plan` field, or include the plan path in `file`, when recording plan-related progress. Use `plan_update` only for meaningful route changes. Use `plan_archive` when the work is complete; it moves the plan from `plans/active/` to `plans/archive/` and appends a finish entry to the worklog.

## Project and stream model

The plugin includes storage primitives for a project registry and explicit user-created streams. Project context is the default. Streams are optional and are intended for separate lines of work that should have their own worklog and plans. Agents should not create or suggest streams automatically; stream selection is intended to be driven by the TUI.

Streams can use the shared project workdir or record an optional git worktree/branch. Worktree merge and cleanup remain explicit user-controlled steps.

## Usage

Add the package to global `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "@kungfusaini/opencode-worklog"
  ]
}
```

To enable the workspace opener inside the opencode TUI, also add the TUI export to `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "@kungfusaini/opencode-worklog/tui"
  ]
}
```

This adds additive command palette actions under `Worklog` without overriding opencode's native session picker:

```text
Open workspace
View worklog
```

Command names:

```text
worklog.workspace.open
worklog.worklog.view
```

Current behavior:

- `Open workspace` chains three simple viewers: project → stream → session.
- The project viewer shows active projects, with pinned projects first and date grouping. Pressing enter opens the project; project management is shortcut-only (`ctrl+f` pin/unpin, `ctrl+r` rename, `ctrl+d` archive).
- Archived projects are available from the project viewer. Archived projects can be restored with `ctrl+r` or permanently deleted with `ctrl+d`. Permanent delete removes local worklog data only; it does not delete the code repository.
- The stream viewer selects `Project worklog`, creates a new stream, or selects an existing active stream.
- The session viewer lists root sessions for the selected project and includes `New session`.
- Session management remains opencode-owned. The plugin does not implement pin, rename, delete, or override the native session picker.
- When a stream is selected, `worklog_append` and plan tools use the stream's worklog and plan directories. Selecting `Project worklog` returns to the project worklog.
- `View worklog` opens the selected project or stream worklog in a searchable read-only dialog.
- The TUI sidebar shows the current worklog project, stream, session, and project workdir. Opencode's native sidebar/session title remains unchanged.

### TUI limitation

The public opencode TUI plugin `DialogSelect` wrapper does not expose the native dialog footer/action-hint props used by opencode's built-in pickers. Project management shortcuts therefore appear as an inert `Shortcuts` row inside the project/archive viewers instead of as native footer tooltips.

After changing plugin config, restart opencode.
