---
name: prime
description: This skill should be used when delegating work to a subagent, teammate, or fresh session. Structures the handoff prompt so the receiving agent starts with full context instead of re-deriving it. Trigger when about to use Agent(), SendMessage(), or write a handoff doc. Supports domain variants (prime render, prime implement, prime review, prime research) that front-load domain knowledge automatically.
---

# /prime -- Agent Delegation Briefing

## The Core Problem

A subagent starts with zero context. It has never seen your conversation. It does not know what you tried, what failed, what constraints you discovered through error, or what the user cares about. A vague delegation ("fix the bug", "make it pretty") forces the receiving agent to spend 15-25% of its token budget on exploration that duplicates work you already did.

This skill structures a handoff prompt that transfers your mental model so the agent begins executing where you left off.

## Theoretical Foundation

The briefing structure synthesizes four traditions that each solve the same problem -- transferring operational context under time pressure to someone who was not present:

**Incident Command System (ICS) incoming-commander transfer.** The outgoing commander briefs the incoming commander in 5 sections: situation, objectives, current actions, resource status, and safety concerns. The critical principle is *situation before mission*: the incoming commander needs to understand the terrain before receiving the objective. In agent delegation, this maps to stating what exists (section 2) before stating what to build (section 5).

**Military Operations Order (OPORD) 5-paragraph format.** Situation, Mission, Execution, Service/Support, Command/Signal. The design principle is *constraints before execution*: coordinating instructions (boundaries, timing, no-go zones) come in the execution paragraph BEFORE the task assignments. An agent that starts building before knowing the constraints will build past them and backtrack. State limits early.

**Pair programming handoff.** The outgoing programmer tells the incoming programmer three things: where I am in the code, what I was trying to do, and what I expect to happen next. The "what I was trying" is the insight that distinguishes a useful handoff from a status report. It transfers *intent*, not just state. In agent delegation, this maps to sections 4 and 5 -- what is wrong and what good looks like.

**Information theory -- minimum description length.** Transfer the model, not the history. A handoff that reproduces the full conversation transcript transfers too much. A handoff that says "fix it" transfers too little. The optimal delegation prompt contains the minimum description that allows the agent to reconstruct your evaluative frame: the set of measurements you would apply to judge its output. Every fact in the prompt should either constrain the search space or define the acceptance criteria. Everything else is noise.

## The 7-Section Briefing

Ordered by how the receiving agent should process them: objective first, then ground truth, then boundaries, then the gap analysis, then the target, then specifics, then deliverable format.

### 1. Mission

What the agent is doing and why it matters. One to three sentences. The agent reads this first and uses it as the completion criterion -- it can check its own output against the mission statement.

The mission is an *objective*, not a *role*. "You are a rendering expert" sets a frame but gives no completion criterion. "Build a 79-col ANSI render of a double-slit experiment that makes someone stop scrolling" gives an objective the agent can evaluate against.

Good: "Review this spec for architectural flaws that would block Phase 5 implementation. Problems found now save 10x the rework cost downstream."

Bad: "You are a reviewer." / "Look at this." / "Help with the spec."

### 2. Situation

What exists. File paths, function names, test counts, what works, what the agent should not rebuild or re-explore. This is the ICS "current situation" brief -- ground truth the agent inherits rather than re-derives.

The key discipline: include what exists AND what the agent should leave alone. An agent that does not know the eye engine already has 41 passing tests may decide to rewrite the test suite.

Good: "The spec is at `docs/specs/2026-04-10-pipeline-design.md` v1.1.0, 1032 lines. Sections 1-6 are stable. Section 7 (scheduling) is the review target. Do not propose changes to sections 1-6."

Bad: "Check the repo." / "Based on your findings..." (pushes your synthesis work onto the agent)

### 3. Constraints

Non-negotiable boundaries. State these before the creative direction (sections 4-6) so the agent frames every decision within bounds from the start. This is the OPORD principle: coordinating instructions before task assignment.

Every constraint you discovered by failing is a constraint the agent will rediscover by failing -- unless you state it here. You learned the canvas is 79 chars wide. You learned near-black RGB values are invisible. You learned the harness strips cursor positioning. Each of these cost you a failed attempt. Transfer the lesson, save the attempt.

Categories: canvas dimensions, runtime environment, file format, API limits, style restrictions, performance budget, tool restrictions.

### 4. Critique (numbered)

What is wrong with the current state. Each item is a concrete observation with a measurement -- a number, a color value, a percentage, a specific behavior. The agent uses this as a defect checklist.

The distinction between a useful critique and a useless one is *measurability*. "The colors need work" is useless -- the agent cannot verify when the colors are "worked" enough. "BG gradient uses RGB (2,1,8) through (14,8,36) -- all near-black, indistinguishable on most displays" gives a measurement the agent can fix and verify.

Real examples from session S253:
- "1. Particle density in the diffraction fan is ~8% per cell -- reads as scattered noise, not gas clouds. The expression-research finding says 40-60% center density with gaussian falloff."
- "2. The gold barrier wall is the only warm-hued element in a violet/indigo scene. It breaks color unity."
- "3. The bottom curve of the eye merges with particles below -- needs 1 clean row of breathing room."

### 5. Vision (numbered)

What good looks like. Each item is a concrete target the agent can verify against its own output. This is the pair programming handoff's "what I expect to happen next" -- it transfers your evaluative frame.

The test: after the agent finishes, it should be able to walk through the vision list and confirm each item is satisfied without asking you. If an item requires your subjective judgment to verify, it is an adjective, not a target. Rewrite it with a measurement.

Good: "Interference peaks on the detection screen should glow -- BG brightness at maxima reaches at least RGB (185, 160, 242)."

Bad: "Make it glow." (how bright? where? compared to what?)

### 6. Technical Direction

Specific values that eliminate aesthetic guesswork. Colors by RGB tuple. Fonts by name. Sizes by measurement. Techniques by reference.

This section is where domain primes (see below) front-load the most value. A generic delegation makes the agent choose its own palette. A primed delegation gives the palette, the reference files, and the known-working techniques.

- Palette: "Deep void (6,3,18). Dark indigo (14,8,42). Violet (90,55,185). Peak (245,238,255). 8-stop ramp with lerp() between stops."
- Technique: "Truecolor BG fills render cleaner than FG block chars. Block elements U+2588/2593/2592/2591 for wall texture."
- References: "Read `docs/hud/substrate-cookbook.md` sections 2 and 3 for canvas constraints. Read `_runs/expression-research.jsonl` entry 9 for composition density findings."

### 7. Deliverable

What the agent returns. Where it goes. How completion is verified. Format this as a concrete handback: the agent knows exactly what to produce and where to put it.

- "Write to `_runs/double-slit-render.cjs`. Run with `node _runs/double-slit-render.cjs`. The terminal output IS the deliverable -- return it verbatim."
- "Write findings to `_runs/s253-review.md`. Rate each P0/P1/P2. Run `npx vitest run` before finalizing."

## Section Selection Guide

Not every task needs all 7 sections.

| Task type | Sections | Why |
|-----------|----------|-----|
| Simple implementation | 1 + 2 + 7 | Clear task, no quality ambiguity, no prior failures |
| Quality-sensitive build | All 7 | Subjective judgment needed, creative decisions within constraints |
| Research / exploration | 1 + 3 + 6 + 7 | No existing artifact; constraints and references matter most |
| Review / audit | 1 + 2 + 3 + 7 | Existing artifact to evaluate; critique and vision are the agent's job |
| Bug fix | 1 + 2 + 4 + 7 | Known defect to reproduce and verify; vision is implicit (the bug is gone) |

## Domain Primes

The generic template works for any delegation. Domain primes front-load sections 3 (constraints) and 6 (technical direction) from the domain's accumulated knowledge, so the delegator writes less and the agent starts with more.

### `/prime render`

Auto-loads: substrate cookbook canvas rules, ANSI survival list (truecolor BG/FG, bold, italic, dim; underline stripped), 79-char Bash canvas width, BG fill requirement, block element codepoint reference, known composition findings from `_runs/expression-research.jsonl`, active palette from the current scene context. The delegator writes mission, situation, critique, vision, and deliverable. Constraints and technical direction come from the domain cache.

### `/prime implement`

Auto-loads: CJS hook conventions (readStdinJson, exit codes, 100ms budget), test patterns (vitest globals not enabled -- explicit imports required), file ownership boundaries, relevant type signatures from the target module, known anti-patterns from `console-log-edit-warn`. The delegator writes mission, situation, and deliverable. Constraints come from the hook contract and test conventions.

### `/prime review`

Auto-loads: DFE pass structure (4 passes: structural, logical, security, integration), known false-positive patterns from prior reviews, quality gate definitions (P0 blocks ship, P1 degrades quality, P2 nice-to-fix), reviewer anti-patterns (rubber-stamping, scope creep, unfounded assertions). The delegator writes mission, situation, and deliverable. The review methodology is pre-loaded.

### `/prime research`

Auto-loads: memory search patterns (2-4 word targeted queries), source evaluation criteria (primary vs secondary, recency, verification status), confidence scoring rubric, output format for `_runs/` reports. The delegator writes mission, constraints (what NOT to research), and deliverable format.

Domain primes connect to the measurement pipeline: `_runs/os/.domain-context.json` is populated at boot by the SessionStart chain, accumulating findings from memory and disk. When a domain prime fires, it reads the warm cache instead of doing live lookups. The boot paid the latency cost; the delegation gets the benefit.

## Anti-Patterns

### Synthesis delegation
"Based on your findings, implement it." You already evaluated findings in your context. The receiving agent has not. Including raw data and asking the agent to synthesize wastes tokens re-deriving conclusions you already reached. Include the conclusions. Section 4 (critique) and section 5 (vision) ARE the synthesis.

### Adjective targeting
"Make it better / cleaner / faster / professional." These are not targets. The agent cannot verify when "better" is achieved because "better" is your internal state, not a measurement. Replace every adjective with a number: a color value, a percentage, a line count, a test count, a specific behavior to observe.

### Conversation bleeding
"The thing we discussed" / "as mentioned earlier" / "the approach you suggested." The receiving agent has zero prior turns. It woke up 3 seconds ago with total amnesia about your session. Name the file, quote the decision, state the constraint. Every pronoun that refers to conversation context is a broken pointer.

### Constraint omission
You discovered through failure that near-black BG gradients are invisible, that the harness strips cursor positioning, that the Bash canvas wraps at column 80, that emoji are double-width. Each discovery cost you an attempt. Omitting discovered constraints from section 3 forces the agent to re-pay that cost. Transfer the lesson; save the attempt.

### Dependency delegation
If you need the agent's output before you can continue, run it foreground. Background agents are for independent work. Delegating a dependency and blocking on it is sequential work disguised as parallel work -- the overhead of delegation exceeds the cost of doing it yourself.

### Output abdication
Delegating a render and accepting the output without running it is not delegation -- it is abdication. Delegation transfers execution but retains judgment. The delegator verifies the deliverable against section 5 (vision). If the vision list was specific enough, verification takes 30 seconds. If it was not specific enough, that is a section 5 problem, not a verification problem.

## Example: Minimal (3 sections)

```
Agent({
  prompt: "Implement session-guard.cjs — detects concurrent CC instances
    by reading _runs/.active-session.json. If another PID is alive and
    marker age < 4h, warn and snapshot .claude/ state.
    Write to .claude/hooks/session-guard.cjs. CJS, readStdinJson pattern.
    Run vitest after."
})
```

Sections present: Mission (detect concurrent instances), Situation (implicit -- new file), Deliverable (path + test). Constraints embedded in situation (CJS, readStdinJson).

## Example: Full (all 7 sections)

The S253 double-slit render delegation. The lead had already: built a v1 render and run it, identified 6 measurable defects, established the 9-stop photon ramp with specific RGB tuples, read the substrate cookbook and canvas rules, observed the user's reaction to v1.

The prompt included:
1. **Mission:** stunning ANSI render of double-slit experiment, not merely correct
2. **Situation:** v2 script at `_runs/double-slit-render.cjs`, physics validated, Line class and rejection sampler work
3. **Constraints:** 79 cols, truecolor, BG fill every cell, no cursor positioning, no emoji
4. **Critique:** 6 items -- particle density 8% (need 30-50%), BG gradient invisible, gold breaks palette unity, barrier not massive enough, |psi|^2 bar banding, detection screen peaks too dim
5. **Vision:** 6 items -- interference peaks glow to RGB (185,160,242)+, smooth |psi|^2 gradient all 79 cols, fan fills full width over 7+ rows, wavefronts visible from source, barrier reads as solid mass, unified indigo/violet palette
6. **Technical direction:** 9-stop photon ramp with RGB tuples, block element codes, blur sigma, particle count targets, composition findings from expression-research.jsonl entry 9
7. **Deliverable:** write to path, run with node, return terminal output

The agent started executing immediately. No exploration phase. The prompt was the codebase.
