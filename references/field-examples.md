# Field examples for agents new to Legatus

Use these historical runs as examples of how to plan, submit, monitor and
recover work. The model choices, timings and costs describe those runs.
Check the current account, limits and workload before reusing a plan.

## Work that delivered results

- **Compare a helper with an upstream CLI.** A remote audit of Legatus and the
  official OpenAI CLI split the work into component reviews. After the first
  round hit rate limits, a narrower retest on GPT‑6.2 Astra at High completed
  both the Legatus and CLI reviews. Keep the exact versions, examine the
  normal entry points and use local fixtures to check consequential claims.
- **Review several projects in one campaign.** A separate Astra High run
  returned all 16 planned reviews across Legatus, DevAiAye and the WoT mod.
  The packets covered code, documentation, tests and operating procedures.
  The plan kept scope and evidence separate by project, and an accepted job
  was recovered after the coordinator restarted using the same Response ID.
  Use a final coverage pass to merge overlaps and identify missing areas.
- **Follow a hosted defensive repository scan.** Daybreak Defense Factory
  scanned a pinned GitHub commit of Legatus. After completion, retrieve the
  findings and the settled usage record. This run recorded **USD 21.77**,
  fully covered by the Daybreak free allowance, with **USD 0 billed**. Its
  one finding was checked against the source, fixed locally and verified
  with a regression test. The Daybreak connector supplies this evidence
  separately from Legatus's project-key API workflows.

The Astra examples used the project API route eligible for linked API credits.
Their receipts establish accepted work, terminal outcomes and token usage.
Per-run grant coverage was not verified in those records. Use billing evidence
to report actual credit applied. Keep Daybreak's scan allowance, API grant
balance and usage incentives scoped to their respective accounts and routes.
See [billing evidence](platform-billing.md).

## A long Astra Max audit

For the DevAiAye 0.4.63 review, **GPT‑6.2 Astra with reasoning effort `max`**
returned 13 static reviews. The packets covered entry points, workflows,
browser lifecycle, providers, documentation and tests. The run journal spans
about **2 hours 12 minutes**, including a pause in local coordination.
Individual provider runs took about **10 to 55 minutes**. The reports were
collected by Response ID and checked against the frozen input plan. Together
the receipts recorded about **2.3 million tokens**, including output and
reasoning. Local checks established which candidates warranted changes.

Reuse the operating pattern when the task warrants this much work:

1. **Plan the coverage and dependency order.** Pin source and documentation
   revisions. Split by coherent component or question and record which files,
   tests and cross-component contracts each part covers. Keep common review
   instructions stable, and give each part a distinct deliverable and logical
   work ID. Reserve a synthesis pass to compare claims and close coverage gaps.
2. **Budget before dispatch.** Confirm which project and route can use the
   available credit. Check TPM, RPM, and any shared queued-input limit
   separately. Count the actual input where supported, including instructions,
   framing and tools. Leave headroom for reasoning, output, later turns, and
   concurrent work. A token or price forecast is advisory. Size the task and
   its explicit limits so it has room to finish.
3. **Balance load across the shared quota.** Start with a representative
   packet. Submit serially when headroom is uncertain. Increase overlap
   only when measured workload and fresh, scope-matched capacity justify it.
   Leave space for other callers and in-flight jobs. A local coordination
   lock covers only clients that use that same pool. A project rate ceiling
   can be reused while current, but available capacity changes during a run.
   Use [delegation](delegation.md) and [deferred work planning](deferred-work.md).
   For example, the historical 16-part High campaign limited its SDK stage
   to two active requests and spaced its own submissions by at least 70
   seconds. Choose concurrency and pacing from the evidence for each run.
4. **Checkpoint each part.** Save the revision, input fingerprint, stable
   work ID, project, model and effort with the submission. Keep the accepted
   Response ID, last observed provider status and result path per part.
   Persist partial results and tool or artifact references independently.
   Pause new admissions when needed and preserve the accepted IDs for
   reconciliation, including across a restart. Keep terminal results until
   their contents and coverage have been reviewed.
5. **Check whether waiting still makes sense.** For managed delegation,
   use `openai-delegate.ps1 Status -WorkId <work-id>`. For an accepted
   Responses job, retrieve the exact Response ID with the same project
   credential. [Checkpoint inventory](workbench.md#discover-and-resume) can
   recover which ID to check, and [Agents monitoring](agents-api.md#watch-continue-and-recover)
   explains the equivalent check for a session and its exact turn.
   Poll at a cadence suited to the job length. Record the last successful
   provider read, state, elapsed time and any new output. A fresh
   `queued` or `in_progress` read confirms the provider still reports an active
   job. An unchanged state confirms neither useful progress nor a finish time.
   A failed read or stopped local watcher leaves the remote status uncertain.
   Compare the elapsed time with the workload, observed peer runs and the
   user's deadline before waiting, investigating or asking about cancellation.
   Verify a requested cancellation against the provider state.
6. **Collect and qualify.** Retrieve terminal envelopes and actual cited
   artifacts before assuming delivery. Check status, scope, remaining work,
   refusals, tool calls, and the integrity of saved results. Review findings
   against the pinned source and safe regression evidence. Merge duplicate
   claims and keep uncertainty visible. Report actual billing separately
   from token usage and any estimate.

## Failures and how to respond

| Observed outcome | What to do next |
| --- | --- |
| Three large Astra requests for Legatus and the CLI ended with `failed / rate_limit_exceeded`. Some still returned useful inline reviews or a cited report. | Save the partial evidence. Recheck the effective limit and overlapping work, then pace or resize only missing work. Qualify coverage independently of the amount of text returned. |
| A DevAiAye 0.4.69 request returned `credit_balance_exhausted`. The remaining packets stayed unsubmitted and the user later closed the queue. | Check the selected project's billing scope and balance. Resume only with an available and authorized funding route. Waiting for a TPM reset addresses a different limit. |
| A live Daybreak Agents pilot returned `403 access_program_not_enabled` despite a working key and visible models. | Check the effective named API project, model and program eligibility. Account-level access and model visibility do not show that the selected project can run the request. |
| A historical local recovery fixture left an explicitly rejected dispatch in the queue as `dispatching`. | Inspect the recorded attempt. Explicit rejection, uncertain submission and local output failure need different recovery. Retrieve or reconcile the existing remote ID before sending replacement work. |

If only part of a Batch is missing, use the documented
[Batch reconciliation workflow](workbench.md#recover-a-partly-completed-batch)
to compare input, output and error rows by identity. Reuse valid results and
submit just the eligible missing work.
