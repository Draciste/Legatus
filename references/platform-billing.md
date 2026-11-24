# OpenAI Platform app and API billing

Install [OpenAI Developers](https://developers.openai.com/learn/developers-codex-plugin)
as part of standard Legatus setup in Codex. It includes the OpenAI Platform app.
Connecting the app is optional and left to the user. Once connected, it provides
account information that can change how work is planned or how a failure is
diagnosed. Legatus uses its selected project API credential independently.
The app connection, ordinary Codex sign-in, and subscription-to-API-organization
link are distinct.

If the app is unconnected, offer a one-time, strong recommendation to sign in
during setup or the first relevant API planning conversation. Explain that
it is Legatus's only direct in-Codex source for figures such as remaining API
credit. The project key can still submit work, but without verified account
data the agent cannot reliably tell whether credits will cover a planned run
or size the run against the available balance. Continue without requiring sign-in and leave
unverified billing details unknown.

## On-demand information and diagnostics

Inspect whichever relevant information the connected app currently exposes
when it helps with API work or troubleshooting. Use the panel and available
read-only tools, and discover additional views or fields when a task benefits
from them. A quick targeted read may be enough for routine work. For a
surprising or incomplete result, combine the app's observations with the
API response, Legatus receipt, or an appropriate signed-in Platform view.

- **Planning and verification.** Confirm the selected organization and, where
  available, project context. Use balance, benefit and usage observations to
  help choose a suitable route or check aggregate activity after a run.
- **Diagnosing a failed or unexpected run.** Compare the account and scope
  shown by the app with the credential and scope reported for the failing
  API request. Use the exact API error and receipt to distinguish exhausted
  credits, authorization, model access and rate limits. For an unexpected
  charge or missing credit, check the matching usage window and grant details.
- **Diagnosing the connection itself.** Check whether the panel opens, which
  organization it loads, whether data is stale or unavailable, and whether a
  refresh reports an error. The ability to open the panel and the ability to
  execute an API call with a separate project key are separate observations.

Record the source, time and scope when they matter. Keep unsupported or
unavailable details explicit. This is an optional read path. Use the relevant
Platform view or API route for fields the app does not expose.

## Balance and usage

1. Discover the installed OpenAI Platform `open_dashboard` action and invoke
   it with `{}` on a supported Codex surface. Read the opened panel's
   **Overview → Billing and usage** using the available app-panel controls.
   The action response opens the panel. Read the panel itself for the amount.
2. Check the displayed API organization before reading the amount. Match it
   to the organization that bills the project key chosen for the run using
   verified project or provider evidence when available. A selected UI name
   or a caller's project hint alone cannot establish the key's billing scope.
   If the match is uncertain, report the shown organization and leave coverage
   for the intended key unknown.
3. Refresh when freshness matters. Report remaining credit with its sign,
   currency and organization, plus the observation time and displayed refresh
   time when useful. The panel also shows total requests and input/output
   tokens. Keep the reporting period unknown if the panel does not show it.
   Use the signed-in [Billing overview](https://platform.openai.com/settings/organization/billing/overview)
   for the balance when the plugin, panel access or matching data is unavailable.
4. Reuse recent scope-matched evidence for routing. Refresh when stale or
   contradicted by the API and material to the decision. For
   `credit_balance_exhausted`, check billing when useful before another
   submission. For a rate-limit error use the existing rate-limit handling.
   Balance and provider acceptance are separate observations. No routine balance
   polling, new connection or change to payment settings is needed.

| Question | Source |
| --- | --- |
| How much API credit remains for the organization? | The panel's **Remaining credit** or the signed-in [Billing overview](https://platform.openai.com/settings/organization/billing/overview). |
| Which credit grants were actually issued and when do they expire? | Signed-in [Credit grants](https://platform.openai.com/settings/organization/billing/credit-grants) for the matching organization. |
| Is there a subscription offer or an existing benefit? | Optional `preview_api_credit_promo` using the current ChatGPT account or workspace. See below. |
| Is this project enrolled for daily complimentary tokens for shared traffic? | Check the organization and project scope in [Data controls → Sharing](https://platform.openai.com/settings/organization/data-controls/sharing). Verify actual usage in [Usage](https://platform.openai.com/usage/chat-completions) grouped by service tier, with input and output selected. The [program's current model and billing requirements](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai) apply. |
| What usage and charges were recorded? | The appropriate provider receipt and [Usage and Costs](https://platform.openai.com/usage), with the correct organization, project and time range. |

The authenticated panel is the available in-Codex source for observing the
organization's remaining credit without a separate signed-in browser. The
`open_dashboard` action opens the panel. Read the value from the panel itself.
The project API, OpenAI CLI and Admin usage and costs routes cannot supply that
remaining-credit figure. Keep the observation attributed to the visible panel
or the signed-in billing page.

## Optional Admin usage and costs

Use `admin.usage.completions` for metered completion usage and
`admin.usage.costs` for recorded monetary amounts. These are read-only actions
with a separately authorized `OPENAI_ADMIN_KEY` in the launching process.
The launcher does not load or try the project credential on these routes.
Choose the matching organization before using this key. Supply explicit
`start_time` and optional exclusive `end_time` as Unix seconds. Filter with
`project_ids` when diagnosing one project. `group_by: ["api_source"]` can
show Agents API activity where the provider attributes it.

Each call returns one page, including raw buckets and currency. Continue with
`receipt.pagination.nextPage` as `page` and keep the same filters. A
`cursor-stalled` or `cursor-unavailable` receipt preserves the page and
omits the continuation token. In a loop, keep the cursors seen for that
query and stop before reusing one or counting that page again.
These observations describe recorded
usage or costs for the queried interval. Admin usage and costs are billing-only
evidence and cannot validate remaining request or token-rate capacity. Use the
Platform panel or signed-in
billing views for remaining credits, individual grants and expiration.
[Admin APIs](https://developers.openai.com/api/docs/guides/admin-apis) ·
[Usage and costs](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage)

## Choosing a model for live API tests

For incidental checks the AI initiates to verify its own tooling or workflow,
such as a live probe of connectivity, authentication or request handling,
prefer a model covered by the current daily complimentary-token program only
when that model can adequately perform the check. Use the
[current model list and program requirements](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)
and check that the selected project's traffic qualifies. Model inclusion alone
does not establish free usage. Organization enrollment, project sharing,
remaining daily quota, balance and operation eligibility also matter.

User-requested testing, such as auditing an artifact for defects, follows the
normal model selection for that assignment, including its scope, capabilities
and expected quality. Apply the incentive preference only to incidental
checks the AI initiates in support of the work. Keep existing offline checks
offline. Use synthetic input for incidental live checks that may be shared
under the incentive.

## Optional subscription benefit check and activation

- `preview_api_credit_promo` is a read-only status or offer check. Read the
  reason together with `eligible`. For example, `already_linked` means an
  existing link, including when the response has `eligible: false`.
- Keep an offer's estimated claim amount separate from an existing benefit's
  recurring amount and cadence. Attribute `expires_at` to the object that
  reports it. Use **Credit grants** for actual issued balances and expiry.
  Preview alone does not prove grant delivery or give a next deposit date.
- For an explicit activation request, follow the installed OpenAI Developers
  setup flow. Preview, discover eligible API organizations as applicable,
  and let the user select and confirm the destination in the native picker.
  Verify the resulting delivery status before treating a grant as usable.
  Preserve the original attempt if linking or delivery remains uncertain.
  Ordinary read-only billing checks leave the link as it is.
- Subscription grants apply to eligible Platform usage billed to the linked
  organization. API-key authentication of Codex itself has separate billing.
  [API credits for ChatGPT subscribers](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

## Optional key setup

For a user-requested new key, the connected OpenAI Platform app offers the
official organization/project and key-name picker. Follow the installed API
key setup skill for its native confirmation of the local destination and
creation of an encrypted key. Use the agreed credential location and keep
secret values out of prompts, logs and command lines. Existing authorized
project keys keep their normal Legatus route. If the app is unavailable,
use ordinary Platform key management and provision the key through the
existing Legatus credential mechanism for the current OS.
