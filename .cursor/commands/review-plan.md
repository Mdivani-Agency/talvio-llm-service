# Review plan

Review the supplied plan, issue, or epic for correctness, completeness, and implementation readiness. Validate it against current evidence and suggest concrete improvements. Do not implement code.

Planning without implementation uses `/plan` (or read `.cursor/commands/plan.md`). Ticket implementation uses `/start-issue` (or read `.cursor/commands/start-issue.md`).

## Gather context

1. Read the target, its parent/sub-issues, dependencies, and linked documents.
2. Check the Notion page titled “Talvio” and the relevant domain documentation.
3. Inspect affected code and current application flows where useful.
4. Search for overlapping work and completed changes that the proposal must preserve.

Distinguish verified behavior, assumptions, and proposed changes. Ticket status alone does not prove that functionality is implemented or deployed.

## Review criteria

Assess whether the proposal:

- Defines a clear problem, outcome, scope, and non-goals.
- Preserves existing functionality and established contracts.
- Fits the current architecture without unnecessary complexity.
- Assigns clear ownership of data, state, interfaces, and side effects.
- Addresses relevant errors, retries, cancellation, recovery, concurrency, and security.
- Includes realistic migration, compatibility, validation, and rollout requirements.
- Has testable acceptance criteria and correctly ordered dependencies.
- Splits implementation into coherent, independently reviewable sub-issues.
- Avoids duplicating existing work or relying on unverified external capabilities.

Scale the review to the task. Do not demand elaborate architecture or operational machinery for a simple change.

## Findings

Prioritize findings by impact:

- **Blocking:** likely incorrect behavior, data loss, security exposure, or an unresolved decision that prevents implementation.
- **Important:** a significant gap, unclear contract, missing acceptance criterion, or avoidable complexity.
- **Optional:** a useful refinement that does not affect readiness.

For each finding, explain:

1. What is missing or incorrect.
2. The concrete consequence or failure scenario.
3. The evidence, with a source link or code reference.
4. The smallest practical improvement.

Example:

> **Blocking — missing credit debit on regenerate.** The plan lets users regenerate a PDF without consuming a credit. Consequence: unlimited paid generations. Evidence: `consume_credits` RPC in `supabase/migrations` and MDI-174 acceptance criteria. Improvement: add “regenerate consumes one credit; failed generate refunds” to the acceptance criteria.

Avoid speculative problems, stylistic preferences presented as requirements, and repeating the same finding across multiple sections.

## Recommendations

- Suggest precise replacement wording or acceptance criteria where helpful.
- Separate required fixes from optional improvements.
- Identify what is already sound and should remain unchanged.
- Highlight decisions requiring user input; resolve routine details using evidence.
- Preserve the implementation rule: complete one sub-issue, submit for review, and wait for an explicit user request before starting the next.

## Output and updates

Return:

- **Verdict:** Ready, Ready with changes, or Not ready.
- Prioritized findings.
- Recommended amendments.
- Unresolved questions and verification limitations.

Default to presenting the review without modifying Notion or Linear. If asked to apply improvements, update the authoritative Notion plan first, then align the Linear issues, dependencies, and acceptance criteria. Verify the updates and provide links.

Do not mark implementation work complete, change its status merely because it was reviewed, or claim verification you did not perform.
