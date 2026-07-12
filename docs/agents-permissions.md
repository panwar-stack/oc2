# Agents And Permissions

Agents combine a role, prompt, model settings, and permission rules. Use
`oc2 agent list` to inspect the agents available in the current project and
`oc2 agent create` to generate an agent Markdown file.

## Built-In Agents

- `build` is the normal primary agent.
- `plan` is a primary planning agent. It denies edits except for its allowed
  plan-file locations.
- `general` is a general-purpose subagent for multi-step work.
- `explore` is a subagent for codebase search and investigation.
- `compaction`, `title`, and `summary` are hidden primary agents used for
  internal session tasks.

Built-ins can be adjusted or disabled through the singular `agent` map.
User-defined agents default to `mode: "all"`.

Built-in agents are not deny-by-default. Their shared baseline allows tools unless a more specific rule asks or denies. It asks for doom-loop operations, most external-directory access, and sensitive `.env` reads; each agent then adds role-specific rules. Global and per-agent permission configuration is merged afterward and can override those built-in rules.

Permissions are operation policy gates, not an OS sandbox. Review the effective policy before running OC2 in an untrusted workspace, and use external isolation when the environment requires a security boundary.

## Define An Agent

The map key is the agent ID. The shipped V1 schema supports `model`, `variant`,
`temperature`, `top_p`, `prompt`, `disable`, `description`, `mode`, `hidden`,
`options`, `color`, `steps`, and `permission`:

```jsonc
{
  "$schema": "https://oc2.ai/config.json",
  "default_agent": "reviewer",
  "agent": {
    "reviewer": {
      "description": "Reviews changes without modifying the worktree.",
      "mode": "primary",
      "temperature": 0.2,
      "steps": 20,
      "permission": {
        "edit": "deny",
        "bash": {
          "*": "ask",
          "git status*": "allow",
          "git diff*": "allow",
        },
      },
    },
  },
}
```

`mode` controls where an agent can run:

- `primary` can lead a session.
- `subagent` can be delegated to but cannot be the default agent.
- `all` can serve either role.

Without `default_agent`, OC2 selects the first visible non-subagent, normally
`build`. If `build` is disabled, it selects the next visible non-subagent. An
explicit `default_agent` is strict: startup fails when the ID is missing,
disabled, hidden, or resolves to a `subagent`. OC2 also fails if no visible
non-subagent remains.

The deprecated `tools` and `maxSteps` agent fields are accepted for
compatibility; use `permission` and `steps` in new definitions.

## Agent Markdown Files

In every configuration directory discovered by OC2, agent files are loaded
from both of these paths:

```text
agent/**/*.md
agents/**/*.md
```

This includes the global XDG configuration directory, project `.oc2`
directories, and `OC2_CONFIG_DIR` when set. See
[Configuration](configuration.md) for the canonical directory and precedence
rules. The path below `agent/` or `agents/`, without `.md`, becomes the agent
ID, so `agents/review/security.md` defines `review/security`.

YAML frontmatter uses the same agent fields as the `agent` map. The Markdown
body becomes `prompt`:

```markdown
---
description: Reviews security-sensitive changes without editing files.
mode: subagent
temperature: 0.1
permission:
  edit: deny
  bash: ask
---

Inspect the requested change, trace trust boundaries, and report concrete
findings with file references.
```

Legacy `mode/*.md` and `modes/*.md` files are also discovered, non-recursively,
and are forced to `primary` mode. Prefer `agent/` or `agents/` for new files.

## Permission Rules

Permissions may be set globally with the singular `permission` key and refined
per agent. Each rule has one of three actions:

- `allow` runs matching operations without prompting.
- `ask` requests approval.
- `deny` blocks matching operations.

A string is shorthand for a rule matching `*`. A pattern map applies actions
to matching operation inputs, such as command text for `bash` or paths for
`read` and `edit`. Permission names and patterns support wildcards.

Rule order is significant at both levels. OC2 evaluates all matching
permission names and patterns, and the **last matching rule wins**. An
unmatched operation defaults to `ask`. Put broad fallbacks first and exceptions
later:

```jsonc
{
  "$schema": "https://oc2.ai/config.json",
  "permission": {
    "*": "ask",
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "edit": "deny",
    "bash": {
      "*": "ask",
      "git status*": "allow",
      "git diff*": "allow",
      "rm *": "deny",
    },
  },
}
```

The `edit` permission also gates write and patch operations. Keep destructive
commands at `ask` or `deny`, and prefer narrow allow patterns over a blanket
`bash: "allow"`.

When prompted, approval can apply once or to the request's offered "always"
patterns. "Always" approvals are stored only in memory for the current running
OC2 instance. They do not modify configuration and are lost when the instance
restarts. Permission and question interactions are described in the
[TUI Guide](tui.md).

## Configured Commands

Configured commands use the singular `command` map. Each entry requires
`template` and may set `description`, `agent`, `model`, `variant`, or `subtask`:

```jsonc
{
  "$schema": "https://oc2.ai/config.json",
  "command": {
    "review": {
      "description": "Review the current changes",
      "template": "Review the current diff for correctness and missing tests.",
      "agent": "reviewer",
    },
  },
}
```

Markdown commands are discovered from `command/**/*.md` and
`commands/**/*.md`; their body becomes `template`. See the
[TUI Guide](tui.md) for configured-command invocation and the
[CLI Reference](cli.md) for `oc2 run --command`.
