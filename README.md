# opencode-worklog

OpenCode server plugin for project worklog tracking and `/worklog` orientation.

## What it provides

- `worklog_append` tool for concise project progress, decision, blocker, and finish entries.
- `/worklog` command handling that toggles tracking for the current project.
- Hidden recap injection when enabling tracking, so the assistant can give a short orientation summary without dumping raw JSONL entries.
- A small reminder while tracking is enabled so the assistant appends meaningful updates and can read deeper history only when needed.

## Usage

Add the package to global `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "@kungfusaini/opencode-worklog"
  ]
}
```

Keep `~/.config/opencode/commands/worklog.md` present so the TUI recognizes `/worklog` as a slash command.

After changing plugin config, restart opencode.
