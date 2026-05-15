# .claude/agents — Specialist subagents for lapsed.ai

This directory contains seven specialist subagent definitions that Claude Code's main session can dispatch in parallel to review work during a build sprint. Each subagent has its own context window, focused system prompt, restricted tool access, and a defined output format.

## The seven specialists

| Subagent | What it does | When to invoke |
|---|---|---|
| **code-reviewer** | Adversarial review against the 12-criterion quality rubric in CLAUDE.md. Returns severity-rated issues with file:line refs. | After any implementation chunk. |
| **vocabulary-auditor** | Sweeps for PRODUCT.md vocabulary violations in user-facing copy ("cohort", "segment", "customer journey", "recovered revenue", etc.). | After any change to UI strings or fixture copy. |
| **design-tenet-auditor** | Walks through the eight design tenets in PRODUCT.md against UI changes. Plus the simplicity test. | After any UI change. |
| **accessibility-auditor** | Runs axe-core on changed routes + manual review of focus rings, aria-labels, keyboard nav, contrast. | After any UI change. |
| **test-coverage-analyzer** | Identifies untested code paths. Critical/High severity for load-bearing or security-critical code. | After any source-file change. |
| **architecture-guardian** | Detects violations of the six load-bearing architectural decisions from CLAUDE.md. The most paranoid auditor. | After any code change that could affect data model, conversation engine, billing math, attribution, or memory graph. |
| **spec-adherence-auditor** | Maps every SPRINT.md acceptance criterion to its file:line implementation + test. Flags GAPs where spec items have no code or no test. Detects out-of-scope creep. | After every commit on a sprint branch (any sprint type). |

## How to use them

### Dispatch pattern (parallel, recommended)

After each implementation chunk in a sprint, dispatch the relevant subagents in parallel:

```
Use the code-reviewer, design-tenet-auditor, accessibility-auditor, and test-coverage-analyzer subagents in parallel to review the changes I just made. Have each one report back independently.
```

Claude Code spawns all four with isolated context windows, runs them concurrently, and returns four structured summaries to the main session. Total wall time is the time of the slowest subagent, not the sum.

### Dispatch pattern (sequential, when output matters)

For some workflows, output from one subagent informs the next:

```
First, run architecture-guardian on this diff. If it reports any violations, stop and surface them. If it passes, then run code-reviewer and test-coverage-analyzer in parallel.
```

### Which subagents to run for each sprint type

**UI-only sprints** (e.g., Sprint 02.5 polish): code-reviewer, design-tenet-auditor, vocabulary-auditor, accessibility-auditor, spec-adherence-auditor. Skip architecture-guardian (UI changes rarely touch load-bearing decisions). Run test-coverage-analyzer for components with logic.

**Data / backend sprints** (Sprint 03, Sprint 04, Sprint 08): architecture-guardian (always), code-reviewer, test-coverage-analyzer, spec-adherence-auditor. Skip the UI-focused auditors.

**Conversation / agent sprints** (Sprint 05, Sprint 06, Sprint 07): all seven. These sprints touch the most load-bearing decisions and have the most surface area for issues.

**Billing sprint** (Sprint 09): architecture-guardian (mandatory — billing math is decision 6), code-reviewer, test-coverage-analyzer, spec-adherence-auditor.

## Calibration notes

- **Block-on-Critical**: any subagent returning a Critical finding should block merge. Don't merge until it's fixed or explicitly waived with documented reasoning.
- **Block-on-architecture-violation**: architecture-guardian's verdicts are absolute. Even a single violation blocks. Retrofitting load-bearing decisions later is far more expensive than fixing them in the originating PR.
- **Block-on-GAP**: spec-adherence-auditor returning a GAP (criterion claimed in SPRINT.md but no implementation or test found) blocks merge. The build agent claimed delivery and didn't deliver — that's a sprint-level miss, not a Medium issue.
- **Disagreement is OK**: subagents may flag the same issue from different angles, or flag things that turn out to be acceptable in context. The main session is the integrator and decides.
- **Don't over-parallelize**: dispatching all six on a one-line change wastes tokens. Pick the relevant subset.
- **Custom subagent invocations**: you can pass extra context (`"focus on the new RevenueChart component"`) when invoking. Each subagent reads its own system prompt plus the invocation context.

## Adding new subagents

If a new pattern emerges (e.g., a `performance-auditor` that profiles bundle sizes, or a `prompt-quality-auditor` that reviews LLM system prompts), drop a new `.md` file in this directory with the same YAML frontmatter format. Claude Code picks it up automatically. Reference the format of the existing six.

## What this isn't

These subagents do not replace the evaluator session pattern in CLAUDE.md. The evaluator runs as a separate Claude Code session against the *merged code* and is binding before the PR is merged. The specialists in this directory run during the build to catch issues fast and parallel. Both layers stay.
