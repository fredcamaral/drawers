---
description: Deep multi-angle web research with adversarial claim verification and a cited report
---

Run the built-in `deep-research` workflow for the question below.

Use the `workflow` tool with `name: "deep-research"` and pass the question as
`args`, i.e. `args = { "question": "<the question below>" }`. This is an explicit
request to run a named workflow, so the orchestration opt-in is satisfied — launch
it rather than researching turn-by-turn yourself.

When the run finishes, relay the cited report it returns (it has already dropped
the claims that failed adversarial verification); surface the citations and note
how many claims were dropped. Do not re-research in this turn.

Question: $ARGUMENTS
