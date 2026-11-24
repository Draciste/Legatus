# Deferred OpenAI API work

Apply when the user requests deferred execution or explicitly accepts waiting
for savings. Follow the parent skill for credentials, model choice, scope and
recovery. A request to compare options calls for advice. If execution is already
authorized and the selected option meets the user's timing, cost and scope,
report the plan and proceed under that authorization.

## Check current options

1. Check the current official [Background guide](https://developers.openai.com/api/docs/guides/background),
   [Batch guide](https://developers.openai.com/api/docs/guides/batch),
   [pricing](https://developers.openai.com/api/docs/pricing), and relevant model
   and endpoint documentation. Compare feasible completion windows, rates,
   service tiers, model/effort/tool support, expiry and dispatch requirements.
   Reuse current evidence for the same conditions within a run. Check again when
   provider terms, project access, model or workload changes. Treat model
   visibility as distinct from eligibility for a specific mode.
2. Check the effective organization and project limits in the [OpenAI limits dashboard](https://platform.openai.com/settings/organization/limits)
   or another authorized source, and compare with the [rate-limit guide](https://developers.openai.com/api/docs/guides/rate-limits).
   Discounted Background modes can share the **queued input-token budget** with
   Batch. Sum input tokens across the planned requests and account for work
   already queued by other clients and projects in the same limit scope. Use
   InputTokens or a clearly marked estimate. Keep headroom and submit coherent
   groups as capacity frees. TPM/RPM headers describe their own limits. Cache
   ceilings as in the parent skill. Treat queue occupancy as transient and state
   when actual remaining capacity is unknown.
3. Recommend the route that best meets the deadline and output quality at the
   estimated total cost. Compare ordinary processing, discounted Background for
   individual or dependent work, and Batch for independent requests. Compare
   input, cached input where applicable, output and separately billed tools or
   follow-ups. State the cost estimate and its assumptions. A discounted rate
   changes cost at a given token volume. Distinguish the provider's first-response
   target or batch window from the time for the entire workflow, including local
   tools, retrieval and synthesis. Identify availability or billing assumptions
   that the current evidence cannot confirm.

## Submit and resume

- **Background.** Use `Responses` over HTTP with `background = $true`,
  `background_options = @{ completion_window = $window }`, and the currently
  required `service_tier`. Use the value verified for the selected model and
  project. Omit streaming with the buffered helper. Use the parent skill's
  Responses request example and save the returned `response.id`. Retrieve it
  with `-Operation RetrieveResponse -ResponseId $id`. A permitted webhook or
  periodic retrieval can detect completion. If the response requests local
  tools, keep the call IDs and output, run authorized tools locally and submit
  their output with the continuation fields in the current Background guide.
  Preserve the same project and continuation settings for linked requests.
- **Batch.** Use the parent skill's Batch workflow with `-BatchCompletionWindow`
  set to the verified value. Confirm the installed CLI accepts the selected
  options if the provider contract changes. If the CLI lags the server, use a
  compatible SDK or the official [Batch API](https://developers.openai.com/api/reference/resources/batches/methods/create)
  with the same authorized project. Prepare UTF-8 JSONL with stable
  `custom_id` values. Submit once, save the batch and input file IDs, and retrieve
  both output and error files when present. Match results by `custom_id` and
  account for failed, expired, and missing rows before retrying specific work.

Before dispatch, use the helper's optional `-CheckpointPath` in the task's
existing checkpoint directory. Record the accepted IDs, project, selected mode/window, submission time and
work mapping in the task's existing checkpoint so Codex can resume after an
interruption. Report queued work as pending, and use the parent skill's recovery
procedure if submission is uncertain. If a limit blocks admission, wait for
capacity or resize coherent chunks. Surface a fallback that would materially
change the expected price or delivery time before using it. Check completed
results against the task and use project usage and billing for actual charges.
