# Architecture Specifications

This directory contains durable OC2 architecture and implementation-ready architecture proposals.

Current specifications explain behavior that is difficult to recover from one source file. Source code remains authoritative for exact schemas, APIs, configuration fields, and implementation details.

Store implementation-ready proposals under `specs/proposals/`. A proposal must define concrete repository changes, compatibility rules, implementation slices, verification, and open decisions. It is not an implemented contract and must not be added to the current-specification list until the implementation lands. Do not store progress reports, generated artifacts, or product positioning here.

## Current Specifications

- [Agent Team Evaluation](./agent-teams/evaluation.md)
- [Fugu Virtual Model](./fugu.md)
- [Local Fusion](./local-fusion.md)
- [Repository Memory](./repository-memory.md)
- [TUI Plugins](./tui/plugins.md)
- [V2 Catalog Transform Decision](./v2/catalog-config-plugin-lifecycle.md)
- [V2 Provider Policy](./v2/provider-policy.md)
- [V2 Session Contract](./v2/session.md)
- [V2 Tool Contract](./v2/tools.md)

## Proposed Specifications

- [Deterministic Agent-Team Orchestration](./proposals/deterministic-agent-team-orchestration.md)
- [Event-Driven Lead Waiting](./proposals/event-driven-lead-waiting.md)
