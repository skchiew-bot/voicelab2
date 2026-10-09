# Voice Lab

Provider-agnostic voice orchestration platform. The blueprint is the source of truth for what to build; `BUILD_PLAN.md` sets the order and the exit criteria for each phase.

## Model selection (applies to every phase)

Token cost is a build requirement. Pick the smallest model that does the task reliably, and escalate only when needed. This applies to the product's runtime AI calls and to any build or dev work that calls a model.

| Task type | Model |
| --- | --- |
| High-volume, per-turn work: tagging intent or sentiment, logging, routine checks, drift screening | Haiku 5.5 |
| Per-change or per-cluster generation: distilling scripts, drafting workflows, summaries | Sonnet 5.5 |
| Low-volume, high-stakes judgement: council reviews, approvals, policy changes, root-causing hard failures | Opus 5.5 |

Rules:
- **Volume decides the tier.** The more often a step runs, the smaller its model. Strong models see only a small share of traffic.
- **Escalate on low confidence.** Start with the smaller model; call the next tier up only when confidence is low or a cheap check flags a problem. Record every escalation in the audit trail.
- **No LLM where a rule will do.** Clustering uses embeddings and thresholds, and validation uses deterministic checks.
- **Cache repeated context.** Rubrics, slot formats and council instructions go in cached prompt prefixes.
- **Batch anything that isn't live.** Distillation, council review and QA scoring run in batches, not in the call path.
- **Model choice is configuration, not code.** Each task's model lives in config, so it can change without a deploy.
- **Measure.** Log model, input tokens and output tokens per task. These roll into the cost record and the Control Tower.
- Do not hardcode prices. Read current pricing before setting the cost model.
- Never put a model name in commit messages (beyond the required co-author line), PR titles or PR bodies.
