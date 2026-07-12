<div align="center">

# OC2

**A coding-agent harness for work that does not fit in one prompt.**

Investigate a repository, edit with permission gates, resume the session later, or divide a larger job among coordinated workers. OC2 keeps the session, tools, repository context, and model provider behind one interface.

![OC2 coding agent interface](./packages/app/public/social-share.png)

</div>

OC2 is an independent project based on and inspired by [opencode](https://github.com/anomalyco/opencode). It is not an official opencode distribution. The agent runtime, session orchestration, tools, and persistence run locally by default; model requests go to your configured provider and may leave your machine.

## From One Prompt To A Coordinated Job

OC2 can handle a focused change in one session. When the work branches, its experimental agent teams give the lead agent a concrete coordination model:

1. Send one worker through the authentication flow and another through the API boundary.
2. Run those investigations in parallel, each in its own durable child session.
3. Hold an implementation worker until its dependencies finish.
4. Require plan approval before that worker receives mutating permissions.
5. Track shared tasks, exchange mailbox messages, and produce a persisted team report.

This is not a collection of isolated subagent calls. Team membership, dependencies, tasks, messages, and results remain attached to the session. Workers can claim tasks transactionally, wake one another through messages, and wait for named dependencies. Coordination is process-local rather than a distributed scheduler.

Use `/use-team` for guided team orchestration. Agent teams are experimental and can also be driven through the team tools exposed to the lead agent.

## One Harness, Several Workflows

The examples below use the built executable as `oc2`. If it is not on your `PATH`, replace `oc2` with `packages/opencode/dist/oc2-<platform>/bin/oc2`.

### Work Interactively

Open the terminal UI in a repository, review tool and permission requests, and return to the latest session later.

```bash
oc2 .
oc2 --continue
```

### Put An Agent In A Pipeline

`oc2 run` accepts a prompt, piped input, or both. Stream readable output to a terminal or JSON to another program.

```bash
git diff | oc2 run "Find correctness issues and missing tests"
oc2 run --format json "Map the files involved in authentication"
```

### Separate The Runtime From The Interface

Start the API once, then attach a terminal or browser interface to it.

```bash
oc2 serve --port 4096
oc2 attach http://localhost:4096
```

`oc2 web --port 4096` starts the server and opens the browser client. Set `OC2_SERVER_PASSWORD` before exposing either server beyond a trusted local machine.

## What The Harness Brings Together

| Capability                   | What it enables                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Durable sessions**         | Resume, fork, import, export, and inspect work without treating every prompt as a new run.                                              |
| **Agents and permissions**   | Give builders, planners, reviewers, and project-specific agents different models, prompts, step limits, and `allow`/`ask`/`deny` rules. |
| **Experimental agent teams** | Coordinate persistent workers with dependencies, shared tasks, mailboxes, broadcasts, plan approval, and effectiveness reports.         |
| **Repository memory**        | Opt in to indexing commit history and file summaries, then search or inspect that index from the CLI and agent tools.                   |
| **Multi-root sessions**      | Attach additional directories while preserving explicit file-tool boundaries and a primary workspace.                                   |
| **Structural search**        | Use OpenGrep-compatible code search when installed, with ordinary text search still available.                                          |
| **Model orchestration**      | Run configured branch, judge, and synthesis models with Local Fusion, or use the optional Fugu virtual model.                           |
| **Extensions**               | Add local or remote MCP servers, runtime or TUI plugins, and permission-gated skills loaded only when needed.                           |
| **Multiple interfaces**      | Use the TUI, non-interactive CLI, browser client, HTTP API, JavaScript SDK, or Agent Client Protocol integration.                       |

## Combine Models Or Repositories Deliberately

### Local Fusion: A Model Panel For One Task

Local Fusion is explicit, task-scoped model orchestration. It sends the same job to configured branch models in parallel child sessions, gives their results to a required structured judge, then asks a synthesizer to return one answer. Invoke a reusable configuration with a slash command:

```text
/local:fusion research "Investigate this bug and propose the safest fix"
```

An agent can also call the `local_fusion` tool with inline branch, judge, and synthesizer definitions. Named configurations are useful when a team wants to reuse the same model panel, stage prompts, tool policies, agents, variants, and branch timeouts.

This workflow helps when developers need to:

- compare independent implementation approaches before editing;
- investigate different parts of a codebase concurrently;
- have another model identify missing evidence or disputed conclusions;
- review a risky change from several perspectives and synthesize one recommendation.

Branches and the judge cannot edit session roots. Write-capable policies are restricted to isolated scratch directories, parent permission denials remain ceilings, and only a suitably permitted synthesizer can apply final workspace changes. Local Fusion is separate from agent teams and cannot run inside an active team session.

### Fugu: Multi-Model Reasoning As A Selectable Model

Fugu is the optional virtual model `fugu/fugu`. Configure one or more branches, an optional judge, and a required synthesizer, then select Fugu as the session model from the model picker or CLI.

```text
{
  "fugu": {
    "branches": [
      { "model": "provider-a/model-a", "variant": "high" },
      { "model": "provider-b/model-b", "variant": "high" }
    ],
    "synthesizer": { "model": "provider-c/model-c" }
  }
}
```

For each provider turn, Fugu privately fans the conversation out to the branch models, optionally obtains judge guidance, and exposes only the synthesizer's final stream and tool calls to the visible session. The TUI and browser client show live orchestration progress without adding private branch output to session history.

Choose Fugu when multi-model comparison should be the normal behavior of a conversation rather than an explicit one-off tool call. Branch and judge tool calls are proposals only; they do not execute. Only synthesizer tool calls can affect the session.

| Local Fusion                                                             | Fugu                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| Explicit command or tool call for a particular task                      | Selectable virtual model for ordinary turns      |
| Parallel durable child sessions                                          | Private provider streams within the current turn |
| Required structured judge                                                | Optional judge                                   |
| Stage-specific agents, prompts, tool policies, scratch space, and limits | Lightweight model and variant targets            |
| Suited to deliberate research, comparison, and review                    | Suited to continuous multi-model conversation    |

Both features make multiple underlying provider requests, increasing latency and provider cost. They are optional and are not required for ordinary OC2 sessions. See [`oc2.example.json`](./oc2.example.json) for configuration examples.

### Multi-Root Sessions: One Conversation Across Related Trees

A session can register multiple working directories, allowing one conversation to work across sibling repositories or separate application, SDK, infrastructure, and documentation trees. Open `/roots` in the TUI to add, rename, remove, or make a root primary.

Relative tool paths resolve from the primary root. Absolute paths inside any registered root are treated as session paths; paths outside every registered root still follow the external-directory permission flow. The roots are included in model context and persist with the session across restarts.

This is useful for changes that cross repository boundaries: updating an API and its client, changing a shared package and its consumer, or keeping implementation and documentation in separate trees without starting disconnected sessions. Removing a root only unregisters it and never deletes its files.

Snapshot and revert coverage remains limited to the primary root. Local Fusion branch and judge stages can inspect secondary roots but cannot edit them.

### Repository Memory: Search How The Code Arrived Here

Repository memory builds a persistent, repository-scoped index of Git history, changed-file activity, co-change relationships, bounded historical diffs, and optional summaries of active files. It helps the agent locate where a similar bug, subsystem, or behavior was handled before without injecting the entire repository history into every prompt.

Indexing is explicit:

```bash
oc2 memory index
oc2 memory status
```

Developers can then search and inspect the index directly:

```bash
oc2 memory search commit "authentication timeout"
oc2 memory examine commit <hash>
oc2 memory search summary "token refresh"
oc2 memory view summary path/to/file.ts
```

Once an active repository has indexed data, the agent receives read-only tools for searching commits and file summaries unless repository memory is disabled in configuration. This can shorten regression tracing, reveal files that commonly change together, find earlier implementations from an error or symbol, and provide a starting map for an unfamiliar long-lived repository. Indexing stays outside model-callable tools, so creating or clearing memory remains an explicit user or API action.

Memory results are localization hypotheses rather than current truth. Historical diffs and line numbers may be stale, and summaries report when their source has changed; the agent must verify every result against the current working tree before editing. Use `--summaries 0` during indexing to retain commit and activity memory without generating model-written file summaries.

## Install From Source

The verified installation path requires [Git](https://git-scm.com/) and Bun 1.3.14.

```bash
git clone https://github.com/panwar-stack/oc2.git
cd oc2
bun install --frozen-lockfile
bun run dev:build
```

The executable is written to `packages/opencode/dist/oc2-<platform>/bin/oc2`. Connect a [model provider](./docs/providers.md), then open a workspace:

```bash
packages/opencode/dist/oc2-*/bin/oc2 providers login
packages/opencode/dist/oc2-*/bin/oc2 .
```

OC2 does not bundle model access. Discover the providers and models available to your installation with `oc2 providers list` and `oc2 models`.

## Control The Agent's Reach

An agent combines a role, prompt, model settings, and operation-specific permission rules. Use the built-in `build` agent for normal work, `plan` for planning with restricted edits, or define agents such as a read-only reviewer. Rules can allow, ask, or deny an operation, with narrower patterns for commands and paths.

Skills use the same permission system: denied skills are not advertised to the model, and loading an available skill performs a permission check. Team plan mode adds a temporary read-only overlay until the lead approves the submitted plan.

Permissions are application policy gates, not an OS sandbox. Review the effective policy before running OC2 in an untrusted workspace, and use external isolation when the environment requires a security boundary. Plugins also run in process and should be treated as trusted code.

## Extend The Working Context

- **MCP:** connect local child processes over stdio or remote servers over Streamable HTTP and SSE, including supported OAuth flows.
- **Plugins:** extend the runtime or TUI from npm packages, local files, or URLs; project plugins can be discovered from `.oc2` directories.
- **Skills:** load focused instruction bundles from the project, user configuration, configured paths, or remote indexes.
- **Providers:** choose from the adapters, configured endpoints, credentials, and plugin contributions visible to the current installation; model IDs use `provider/model` form.

See [Extensions](./docs/extensions.md) and [Providers](./docs/providers.md) for the configuration and trust details.

## Documentation

- [CLI reference](./docs/cli.md)
- [TUI guide](./docs/tui.md)
- [Configuration](./docs/configuration.md)
- [Providers](./docs/providers.md)
- [Agents and permissions](./docs/agents-permissions.md)
- [Extensions: MCP, plugins, and skills](./docs/extensions.md)
- [Environment variables](./docs/reference/environment.md)
- [Keybindings](./docs/reference/keybindings.md)

## Browser And Source Development

Release binaries embed the browser assets used by `oc2 web`. If those assets are missing or disabled, OC2 returns a local `503`; it does not proxy to a hosted application.

For browser-interface development, run the backend and Vite app as separate processes:

```bash
# Terminal 1
bun dev serve --port 4096

# Terminal 2
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`; by default, the app targets the backend at `http://localhost:4096`. Other source commands use `bun dev`, such as `bun dev .` and `bun dev run "Explain this repository"`.

## Contributing And License

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [packages/onboarding.md](./packages/onboarding.md) for the workspace map. OC2 is available under the [MIT License](./LICENSE).
