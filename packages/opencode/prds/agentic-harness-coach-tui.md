Here are real OpenCode interactive terminal user interface mocks for the coaching layer. I treated coaching as a native terminal surface, not a separate help panel, because the product requirements document calls for contextual, actionable, concise, non blocking tips across before run, during run, and after run moments. OpenCode already supports an interactive terminal interface, prompts, file references through `@`, slash commands, and model commands, so the mocks lean into those existing patterns. ([OpenCode][1])

## 1. Core terminal layout

The best pattern is a persistent coach rail on the right, with one focused recommendation at a time. The rail can expand into a compare view or action menu, but it should not block the prompt editor.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  new        agent  Build             │
├───────────────────────────────────────┬───────────────────────────────┤
│ conversation                          │ Coach                         │
│                                       │                               │
│ You                                   │ 3 suggestions before running  │
│ Fix this.                             │                               │
│                                       │ ❯ Improve prompt              │
│                                       │   Add context, format, done   │
│                                       │                               │
│                                       │   Use single agent            │
│                                       │   Full team likely too much   │
│                                       │                               │
│                                       │   Switch model                │
│                                       │   Lower cost fit is likely    │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ message                                                               │
│ Fix this.                                                            │
│                                                                       │
│ Control K actions   Tab agent   slash commands   Enter run            │
╰───────────────────────────────────────────────────────────────────────╯
```

Why this works: it keeps the user in flow, supports one click actions, and avoids making coaching feel like review or judgment. The product requirements document specifically asks for one click prompt replacement, model switching, single agent mode, acceptance criteria insertion, task splitting, template saving, dismissals, and feedback controls.

## 2. Better prompt suggestion mock

Use case coverage: vague prompt, stronger prompt, output format coaching, acceptance criteria coaching.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme docs       session  draft edit       agent  Build       │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Make this better.                     │ Prompt quality  42 of 100     │
│                                       │                               │
│                                       │ This may work better with     │
│                                       │ context, audience, tone,      │
│                                       │ output format, and done.      │
│                                       │                               │
│                                       │ Suggested prompt              │
│                                       │ Review the attached file for  │
│                                       │ clarity, grammar, and tone.   │
│                                       │ Preserve the meaning. Return  │
│                                       │ a clean version and a short   │
│                                       │ list of important changes.    │
│                                       │                               │
│                                       │ ❯ Apply improved prompt       │
│                                       │   Add output format only      │
│                                       │   Add done criteria           │
│                                       │   Dismiss this run            │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Enter run   Control K actions   Control C close coach                 │
╰───────────────────────────────────────────────────────────────────────╯
```

Interaction detail: pressing Enter on “Apply improved prompt” replaces the editor content in place and leaves the cursor at the end so the user can edit before running.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme docs       session  draft edit       agent  Build       │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Review the attached file for clarity, │ Applied                       │
│ grammar, and tone. Preserve the       │                               │
│ original meaning. Return a clean      │ Your prompt now includes      │
│ edited version and a short list of    │ goal, constraints, output,    │
│ important changes.                    │ and done criteria.            │
│                                       │                               │
│                                       │ Quality  42 to 82             │
│                                       │                               │
│                                       │ ❯ Run with this prompt        │
│                                       │   Keep editing                │
│                                       │   Undo apply                  │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Enter run   Control Z undo   Control K actions                        │
╰───────────────────────────────────────────────────────────────────────╯
```

The product requirements document names prompt quality score, top improvement opportunities, suggested rewritten prompt, and explanation of why the revision is better as outputs of the prompt analyzer.

## 3. Simple rewrite with agent team overkill and cheaper model

Use case coverage: simple rewrite, agent team overkill, cheaper model recommendation, cost and latency preview.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme docs     session  customer email     agent team  six    │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Rewrite this customer email so it     │ Setup fit                     │
│ sounds more professional.             │                               │
│                                       │ Task type       rewrite       │
│                                       │ Team fit        too large     │
│                                       │ Model fit       too strong    │
│                                       │ Cost            medium        │
│                                       │ Latency         medium        │
│                                       │                               │
│                                       │ This looks simple enough for  │
│                                       │ one agent. A full team may    │
│                                       │ add time without improving    │
│                                       │ quality.                      │
│                                       │                               │
│                                       │ ❯ Use single agent            │
│                                       │   Switch to standard model    │
│                                       │   Apply both                  │
│                                       │   Run anyway                  │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ estimated impact  lower cost  lower wait  quality risk low            │
╰───────────────────────────────────────────────────────────────────────╯
```

After selecting “Apply both”:

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme docs     session  customer email     agent  Build       │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Rewrite this customer email so it     │ Setup improved                │
│ sounds more professional.             │                               │
│                                       │ Team                           │
│                                       │ six agents to one agent       │
│                                       │                               │
│                                       │ Model                          │
│                                       │ premium to standard           │
│                                       │                               │
│                                       │ Tradeoff                      │
│                                       │ Best for formatting, rewrite, │
│                                       │ and cleanup. Use premium if   │
│                                       │ business critical nuance is   │
│                                       │ the priority.                 │
│                                       │                               │
│                                       │ ❯ Run                         │
│                                       │   Revert setup                │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ cost low to medium     latency low     confidence high                │
╰───────────────────────────────────────────────────────────────────────╯
```

The product requirements document calls out agent team overkill for rewrite, summary, extraction, classification, formatting, and simple code explanation tasks, and separately calls for cheaper model recommendations when a task is low risk and mostly transformation work.

## 4. Complex repository task with missing context and premium model justification

Use case coverage: missing context, tool fit coaching, premium model justification, complex repository task.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  billing flow       agent  Plan      │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Implement the new billing flow.       │ Missing context               │
│                                       │                               │
│                                       │ This is likely a good fit for │
│                                       │ Plan first and a stronger     │
│                                       │ model because it touches      │
│                                       │ product behavior and several  │
│                                       │ files.                        │
│                                       │                               │
│                                       │ Add these before running      │
│                                       │ ○ source requirements         │
│                                       │ ○ target files                │
│                                       │ ○ expected behavior           │
│                                       │ ○ tests to update             │
│                                       │ ○ rollout constraints         │
│                                       │                               │
│                                       │ ❯ Add context checklist       │
│                                       │   Attach files with @         │
│                                       │   Start in Plan               │
│                                       │   Run anyway                  │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Tip  type @ to attach files from this project                         │
╰───────────────────────────────────────────────────────────────────────╯
```

Expanded checklist after action:

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  billing flow       agent  Plan      │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Implement the new billing flow.       │ Context checklist added       │
│                                       │                               │
│ Context                               │ The task is now easier to     │
│ Source requirements                   │ scope and verify.             │
│ @docs/billing/new flow.md             │                               │
│                                       │ Model fit                     │
│ Target files                          │ Premium is justified          │
│ @src/billing                          │                               │
│ @src/checkout                         │ Team fit                      │
│                                       │ Plan first, then Build        │
│ Done when                             │                               │
│ Existing checkout behavior remains    │ ❯ Run plan                    │
│ unchanged unless listed in the spec.  │   Switch to Build now         │
│ Billing tests pass. A summary is      │   Save as template            │
│ returned.                             │                               │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Enter run   Tab switch agent   slash models                           │
╰───────────────────────────────────────────────────────────────────────╯
```

OpenCode documentation says file references can be added through `@`, and Plan mode can be used to analyze code and review suggestions without making code changes. ([OpenCode][1])

## 5. Team composition coaching mock

Use case coverage: unnecessary roles, duplicate roles, missing roles, simpler setup, estimated speed and cost impact.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme api        session  grammar cleanup    setup            │
├───────────────────────────────────────┬───────────────────────────────┤
│ selected team                         │ Coach                         │
│                                       │                               │
│ ◉ Planner                             │ Team fit  too large           │
│ ◉ Researcher                          │                               │
│ ◉ Researcher two                      │ Duplicate role                │
│ ◉ Implementer                         │ Researcher and Researcher two │
│ ◉ Reviewer                            │ overlap for this task.        │
│ ◉ Release notes                       │                               │
│                                       │ Recommended setup             │
│                                       │ One Build agent               │
│                                       │                               │
│                                       │ Impact                        │
│                                       │ Cost lower                    │
│                                       │ Wait lower                    │
│                                       │ Quality risk low              │
│                                       │                               │
│                                       │ ❯ Use recommended setup       │
│                                       │   Keep reviewer only          │
│                                       │   Keep current setup          │
│                                       │   Do not show for rewrites    │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Space toggle role   Enter apply   Escape cancel                       │
╰───────────────────────────────────────────────────────────────────────╯
```

This maps directly to the agent team fit analyzer requirements: team fit rating, simpler recommended setup, missing role warning, duplicate role warning, and estimated speed and cost impact.

## 6. Broad task decomposition mock

Use case coverage: oversized task, split into smaller runs, one action to create subtasks.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  growth project     agent  Plan      │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Research competitors, design the new  │ Scope looks broad             │
│ onboarding flow, implement it, and    │                               │
│ write launch notes.                   │ This combines research,       │
│                                       │ design, implementation, and   │
│                                       │ validation. Splitting gives   │
│                                       │ better control.               │
│                                       │                               │
│                                       │ Suggested task queue          │
│                                       │ 1 Research competitors        │
│                                       │ 2 Draft onboarding design     │
│                                       │ 3 Implement approved flow     │
│                                       │ 4 Validate and write notes    │
│                                       │                               │
│                                       │ ❯ Create task queue           │
│                                       │   Add split plan to prompt    │
│                                       │   Run as one task             │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ selected action creates four sessions linked to this session           │
╰───────────────────────────────────────────────────────────────────────╯
```

After selecting “Create task queue”:

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  growth project     queue            │
├───────────────────────────────────────┬───────────────────────────────┤
│ task queue                            │ Coach                         │
│                                       │                               │
│ ❯ 1 Research competitors              │ Queue created                 │
│   Goal  compare onboarding patterns   │                               │
│   Output  findings list               │ Each task has its own done    │
│                                       │ criteria and output format.   │
│   2 Draft onboarding design           │                               │
│   Goal  propose user flow             │ Start with research. Use the  │
│   Output  design brief                │ results as context for task   │
│                                       │ two.                          │
│   3 Implement approved flow           │                               │
│   Goal  code approved design          │ ❯ Run selected task           │
│   Output  code changes and tests      │   Edit selected task          │
│                                       │   Merge back to one task      │
│   4 Validate and write notes          │                               │
│   Goal  run checks and summarize      │                               │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Up down select   Enter run   E edit                                    │
╰───────────────────────────────────────────────────────────────────────╯
```

The product requirements document lists task decomposition as a key coaching use case and includes “Split into subtasks” as a one click action.

## 7. During run coaching mock

Use case coverage: poor task setup, excessive exploration, repeated tool use, runaway complexity, light touch guidance.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  billing flow       running          │
├───────────────────────────────────────┬───────────────────────────────┤
│ run timeline                          │ Coach                         │
│                                       │                               │
│ ✓ scanned package files               │ Live note                     │
│ ✓ opened billing service              │                               │
│ ✓ searched for checkout events        │ The agent is spending time    │
│ ○ asking what success means           │ inferring scope. Next time,   │
│ ○ searching related tests             │ include expected behavior     │
│                                       │ and tests in the prompt.      │
│ tool activity                         │                               │
│ read files          18                │ No action needed now.         │
│ searches            9                 │                               │
│ edits               0                 │ ❯ Add note to retrospective   │
│ elapsed             medium            │   Create follow up context    │
│                                       │   Mute live tips              │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ run continues   Control K actions   slash details                      │
╰───────────────────────────────────────────────────────────────────────╯
```

The during run experience should never interrupt execution unless there is an organization policy. The product requirements document says during run coaching should detect poor setup, excessive exploration, repeated tool use, missing context, or runaway complexity, while providing light touch guidance.

## 8. Post run retrospective mock

Use case coverage: after run learning, better next prompt, model fit, team fit, reusable template, tip feedback.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme docs       session  customer email     completed        │
├───────────────────────────────────────┬───────────────────────────────┤
│ result                                │ Coach                         │
│                                       │                               │
│ Edited customer email                 │ Run retrospective             │
│                                       │                               │
│ Summary                               │ What worked                   │
│ The email is clearer and more direct. │ Clear goal                    │
│                                       │                               │
│ Important changes                     │ What made it harder           │
│ 1 Shortened the opening               │ No audience or tone           │
│ 2 Made the ask explicit               │ No output format              │
│ 3 Preserved the original meaning      │ Team was larger than needed   │
│                                       │                               │
│                                       │ Next time use                 │
│                                       │ Rewrite this customer email   │
│                                       │ for enterprise buyers. Use a  │
│                                       │ calm, professional tone.      │
│                                       │ Return the final email and    │
│                                       │ three important changes.      │
│                                       │                               │
│                                       │ ❯ Save as template            │
│                                       │   Copy better prompt          │
│                                       │   Try cheaper setup next time │
│                                       │   Useful  Not useful  Wrong   │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Enter select   C copy   F feedback                                     │
╰───────────────────────────────────────────────────────────────────────╯
```

The product requirements document asks the post run summary to include what worked, what made the run harder, a better prompt, team fit, model fit, and a suggested reusable template.

## 9. Prompt pattern library mock

Use case coverage: convert successful prompt into reusable template.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme docs       session  template save      library          │
├───────────────────────────────────────┬───────────────────────────────┤
│ save template                         │ Coach                         │
│                                       │                               │
│ Name                                  │ Template ready                │
│ Customer email rewrite                │                               │
│                                       │ Saved fields                  │
│ Template                              │ Goal                          │
│ Rewrite this customer email for       │ Context                       │
│ [audience]. Use a [tone] tone.        │ Tone                          │
│ Preserve meaning. Return the final    │ Output format                 │
│ email and [number] important changes. │ Done criteria                 │
│                                       │                               │
│ Suggested tags                        │ Reuse with                    │
│ writing                               │ slash templates               │
│ customer                              │                               │
│ rewrite                               │ ❯ Save template               │
│                                       │   Copy template               │
│                                       │   Cancel                      │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Enter save   slash templates opens library                             │
╰───────────────────────────────────────────────────────────────────────╯
```

## 10. Repeated mistake coaching mock

Use case coverage: personalization without a full learning curriculum.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  new              agent  Build       │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Summarize this.                       │ Pattern noticed               │
│                                       │                               │
│                                       │ Your accepted prompts often   │
│                                       │ perform better when they      │
│                                       │ include one good example.     │
│                                       │                               │
│                                       │ Add example block             │
│                                       │ Example output                │
│                                       │ [paste a good sample here]    │
│                                       │                               │
│                                       │ Avoid                         │
│                                       │ [paste a bad sample here]     │
│                                       │                               │
│                                       │ ❯ Insert example block        │
│                                       │   Not for this task           │
│                                       │   Stop showing this tip       │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ personal coaching level  normal                                        │
╰───────────────────────────────────────────────────────────────────────╯
```

The product requirements document says coaching should adapt based on repeated behavior, accepted suggestions, dismissed suggestions, team preferences, and task history.

## 11. Learning mode and quiet mode mock

Use case coverage: learning mode for new users and quiet mode for expert users.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        command  slash coach                         │
├───────────────────────────────────────┬───────────────────────────────┤
│ coaching settings                     │ Preview                       │
│                                       │                               │
│ Coaching level                        │ Learning                      │
│ ○ Quiet                               │ More explanation, examples,   │
│ ◉ Normal                              │ and prompt rewrites.          │
│ ○ Learning                            │                               │
│                                       │ Normal                        │
│ Show                                  │ One focused tip per moment.   │
│ ◉ prompt tips                         │                               │
│ ◉ model tips                          │ Quiet                         │
│ ◉ agent tips                          │ Only high confidence warnings │
│ ◉ cost and latency                    │ and organization policies.    │
│ ◉ run retrospectives                  │                               │
│                                       │ ❯ Save                        │
│ Feedback memory                       │   Reset to organization       │
│ ◉ use my accepted and dismissed tips  │   Cancel                      │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ Space toggle   Enter save   Escape cancel                             │
╰───────────────────────────────────────────────────────────────────────╯
```

## 12. Administrator policy warning mock

Use case coverage: administrator guidance, high cost warning, user control where allowed.

```text
╭────────────────────────────── OpenCode ──────────────────────────────╮
│ project  acme web        session  data cleanup       policy           │
├───────────────────────────────────────┬───────────────────────────────┤
│ message editor                        │ Coach                         │
│                                       │                               │
│ Normalize this small CSV and return   │ Organization guidance         │
│ a cleaned version.                    │                               │
│                                       │ Your workspace encourages     │
│ Selected setup                        │ standard models for simple    │
│ premium model                         │ formatting tasks.             │
│ six agent team                        │                               │
│                                       │ Current setup                 │
│                                       │ Cost likely high              │
│                                       │ Latency likely high           │
│                                       │ Quality gain likely low       │
│                                       │                               │
│                                       │ ❯ Switch to standard model    │
│                                       │   Use single agent            │
│                                       │   Apply both                  │
│                                       │   Continue with reason        │
│                                       │                               │
├───────────────────────────────────────┴───────────────────────────────┤
│ This is a warning, not a block.                                        │
╰───────────────────────────────────────────────────────────────────────╯
```

The product requirements document includes administrator controls for default coaching level, budget sensitivity, model recommendation policy, agent team warning thresholds, high cost warnings, and override settings.

## 13. Best default interaction model

1. Coach rail is collapsed by default unless there is a high confidence recommendation.

2. The first card is always the highest leverage action, such as “Apply improved prompt” or “Use single agent.”

3. Each card has only three to five actions.

4. The user can always run anyway unless policy says otherwise.

5. Feedback is inline after action or after run: Useful, Not useful, Wrong.

6. Cost and latency use qualitative labels, not exact numbers, unless exact data is available.

7. Learning mode expands explanations, while quiet mode keeps only high confidence warnings.

8. During run coaching should be retrospective oriented unless immediate intervention would save a bad run.

## 14. First release mock set to build

Build these screens first:

1. Before run prompt review rail.

2. Improved prompt compare and apply state.

3. Agent team overkill setup card.

4. Cheaper model recommendation card with tradeoff.

5. Missing context checklist for repository tasks.

6. During run live note card.

7. Post run retrospective card.

8. Feedback and dismiss menu.

That set covers the first release scope: prompt quality review, suggested improved prompt, agent team overkill detection, cheaper model recommendation, missing context warnings, output format suggestions, post run learning summary, and tip feedback controls.

[1]: https://opencode.ai/docs/tui/ "TUI | OpenCode"
