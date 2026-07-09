<p align="center">
  <a href="https://oc2.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC2 logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://oc2.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/oc2-ai"><img alt="npm" src="https://img.shields.io/npm/v/oc2-ai?style=flat-square" /></a>
  <a href="https://github.com/panwar-stack/oc2/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

[![OC2 Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://oc2.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://oc2.ai/install | bash

# Package managers
npm i -g oc2-ai@latest        # or bun/pnpm/yarn
scoop install oc2             # Windows
choco install oc2             # Windows
brew install anomalyco/tap/oc2 # macOS and Linux (recommended, always up to date)
brew install oc2              # macOS and Linux (official brew formula, updated less)
sudo pacman -S oc2            # Arch Linux (Stable)
paru -S oc2-bin               # Arch Linux (Latest from AUR)
mise use -g oc2               # Any OS
nix run nixpkgs#oc2           # or github:anomalyco/opencode for latest dev branch
```

Legacy commands, config files, env vars, and install URLs remain supported as migration aliases. Prefer `oc2` names for new installs and documentation.

> [!TIP]
> Remove versions older than 0.1.x before installing.

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OC2_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.oc2/bin` - Default fallback

```bash
# Examples
OC2_INSTALL_DIR=/usr/local/bin curl -fsSL https://oc2.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://oc2.ai/install | bash
```

### Agents

OC2 includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Subagents are specialized agent types that a primary agent can invoke for a task. Teammates are different: they are background child sessions in an agent team, each with its own name, agent type, role prompt, dependencies, mailbox messages, and optional plan approval. A teammate can run a subagent type, but "teammate" is the team coordination role, not an agent mode.

Learn more about [agents](https://oc2.ai/docs/agents).

### Feature Highlights

#### Agent Teams (Experimental)

Agent teams let one lead session coordinate multiple background teammate sessions for work that can be split across specialists.

- Enable with `"experimental": { "agent_teams": true }` in `oc2.json`
- Spawn teammates with their own agent type, model, role prompt, dependencies, and optional plan approval
- Coordinate through mailbox messages, broadcasts, shared task lists, and automatic dependency unblocking
- Use the TUI team panel to inspect teammate status, pending questions, shared tasks, messages, and shutdown controls
- Generate post-run effectiveness reports with `team_report` or `/team-report`, including throughput, lifecycle, dependency, messaging, cost, token, and evaluation summaries
- Inspect teams through the HTTP API and generated JavaScript SDK, including `/team/{teamID}/eval` for deterministic DAG-based evaluation findings

Subagents cannot create nested agent teams, and team tools stay scoped to lead and teammate sessions.

Learn more in the [agent teams docs](https://oc2.ai/docs/agent-teams).

#### Local Fusion

`local_fusion` runs local compound model orchestration from a normal OC2 session. It fans one prompt out to inline configured branch models, judges the branch outputs, and synthesizes one final answer without using a remote compound-model provider.

- Configure branches, judge, and synthesizer inline in the tool input
- Branches default to read/search-only tools, with `toolPolicy: "none"` available per branch
- Judge and synthesizer run with tools disabled
- Partial branch failures continue when at least one branch succeeds; all-branch, judge, and synthesizer failures fail loudly

Named compound configs and `model: "compound/..."` routing are not included in this first version.

Learn more in the [tools docs](https://oc2.ai/docs/tools#local_fusion).

#### Session Export

`oc2 export` now includes child sessions recursively, so exported JSON captures subagent and teammate work along with the lead session.

#### Repository Memory

Repository memory indexes local git history and high-activity file summaries so agents can use historical localization hints before reading source. It is enabled by default, but tools require an index from `oc2 memory index`. Disable it with `"memory": { "enabled": false }`. Memory is historical, so agents must verify every hint against current source before editing.

Learn more in the [memory docs](https://oc2.ai/docs/memory).

### Documentation

For more info on how to configure OC2, [**head over to our docs**](https://oc2.ai/docs).

### Contributing

If you're interested in contributing to OC2, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

Useful contributor helpers:

- `bun run dev:build` builds the OC2 package with the single-binary build shortcut
- `/clarify` narrows underspecified requests before planning or implementation
- `/spec-planner` drafts repo-style implementation specs with verification slices
- `/init` runs guided `AGENTS.md` setup and adds the repo's required coding principles
- `/team-report` runs the team report tool for the active or most recent team session

### Building on OC2

If you are working on a project that's related to OC2 and is using "oc2" as part of its name, for example "oc2-dashboard" or "oc2-mobile", please add a note to your README to clarify that it is not built by the OC2 team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
