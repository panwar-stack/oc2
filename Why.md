# Why OC2

OC2 is for people who want a complete coding-agent harness that they can run and inspect on their own machine. For a local workspace, the process, session orchestration, filesystem and tool execution, and persistence stay local by default; attach, remote, and provider tools can connect elsewhere. Model calls go to the configured provider endpoint, which may be local.

Minimal does not mean a starter skeleton or a reduced agent loop. It describes a focused distribution and narrower assumptions about OC2-operated services while retaining configurable providers and agents, persistent sessions, permission-gated tools, and CLI, TUI, server, and browser interfaces.

OC2 is based on and inspired by opencode, but it is an independent project rather than an official opencode distribution. It keeps useful upstream architecture and compatibility while focusing on coordinated, inspectable AI-assisted development.

The largest addition is experimental agent teams. A lead session can split work across named teammates, coordinate through messages and shared tasks, wait on dependencies, request plan approval, and produce a report afterward. This helps when a task is too broad for one linear agent loop.

OC2 also improves visibility around larger work. Session exports include child-session work, AI processing time is tracked more clearly, and team reports help explain what happened during a coordinated run. Built-in workflows such as spec planning, initialization guidance, and team reporting make repeated engineering tasks easier to standardize.

Some of this remains early. Agent teams are experimental, team reports are operational signals rather than proof of correctness, and multi-root session work is foundational rather than a complete UX story.

Use OC2 if you value local control, coordination, and auditability without giving up a full coding-agent execution loop.
