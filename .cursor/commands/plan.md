# Plan

Research requirements and publish an actionable technical plan. Write the plan in Notion first, then create or update Linear issues. Do not implement code or deploy changes unless explicitly asked. For reviewing a published plan or issue, use `/review-plan` (or read `.cursor/commands/review-plan.md`). For implementing an assigned ticket, use `/start-issue` (or read `.cursor/commands/start-issue.md`).

## Before planning

1. Read the user’s request and any referenced Linear tickets, parent epics, sub-issues, and dependencies.
2. Find the Notion page titled “Talvio”. Read its overview and the relevant domain pages.
3. Inspect the current code and, when useful and accessible, the application’s current flows.
4. Search Notion and Linear for existing plans or overlapping work before creating anything.
5. Distinguish verified behavior, proposed changes, assumptions, and unresolved questions. Do not treat an existing document or completed ticket as proof of deployed behavior.

Resolve routine choices from available evidence. Ask only when a material ambiguity prevents a sound plan.

## Plan quality

- Lead with the problem, intended outcome, and user-visible behavior.
- Preserve existing functionality unless a change is explicitly justified.
- Define scope, non-goals, affected domains, dependencies, and acceptance criteria.
- Explain state and data ownership, interfaces, persistence, and compatibility where relevant.
- Cover loading, empty states, failures, retries, cancellation, recovery, and concurrent changes when applicable.
- Include migration, validation, rollout, and rollback considerations proportional to the change.
- Identify risks and decisions that require verification before implementation.
- Prefer the simplest architecture that satisfies the requirements. Do not add frameworks, services, or abstractions without a concrete need.
- Link evidence and authoritative technical references. Never present assumptions as confirmed facts.

## Notion first

Before creating implementation issues in Linear:

1. Write the proposed plan in Notion under Talvio.
2. Update the existing authoritative domain page when an appropriate plan already exists.
3. Create a new page only when the work needs a distinct scope.
4. Mark the plan as **Proposed**, with a last-reviewed date and any unresolved decisions.
5. Verify that the page was saved successfully and has the correct parent.

Do not label a plan **Approved**, **Implemented**, or **Deployed** without evidence supporting that status.

## Documentation organization

Use the authoritative domain list and page-structure rules in `.cursor/commands/start-issue.md` (Documentation organization). Do not maintain a second domain list here.

When writing a plan, use sections appropriate to the work: problem and goals; current behavior and evidence; proposed behavior and architecture; contracts and data ownership; failure and recovery; delivery plan and dependencies; acceptance criteria and validation; risks, open decisions, and references.

Preserve unrelated content and established decisions. Explain proposed changes to earlier decisions. Separate historical designs from current guidance.

## Linear issues

After the Notion plan is saved:

- Create issues from the plan, or update matching existing issues rather than creating duplicates.
- Use the Talvio project and MDI team. When `.cursor/rules/linear.mdc` is present, follow the project id and conventions there instead of hard-coding them.
- Link the Notion plan in the parent issue and every implementation sub-issue.
- For multi-stage work, create a parent epic with independently reviewable sub-issues.
- Give each issue a concrete outcome-oriented title, the problem and intended behavior, explicit scope and exclusions, relevant interfaces and constraints, testable acceptance criteria, validation expectations, and dependencies.
- Add blocking relationships only where the dependency is real.
- Keep issue boundaries clear. Preserve useful context when expanding an existing issue into an epic.

Use **Backlog** for proposed implementation work. Do not mark issues **In Progress** merely because a plan was written. Do not invent assignees, estimates, deadlines, or priorities.

Example title: `LLM 3/14: provision Bedrock queues and private artifacts`

## Reviewable delivery sequence

- Break work into sub-issues that can each produce a coherent, review-ready change.
- Specify the recommended implementation order.
- Record that implementation agents must complete one sub-issue, submit it for review, and stop. Use `/start-issue` (or read `.cursor/commands/start-issue.md`) for that work.
- Approval or merge alone does not authorize starting the next sub-issue; the user must explicitly request continuation.
- This restriction does not prevent creating the full proposed breakdown in one planning task.

## Keep the plan and issues aligned

- Add the created Linear issue links back into the Notion plan.
- Keep issue scope, dependencies, and acceptance criteria matched to the published design.
- If planning reveals a material change, update Notion first, then update the affected issues.
- Identify decisions still awaiting approval. Do not hide them inside implementation instructions.

## Final handoff

Before finishing:

- Verify the Notion page’s content and location.
- Verify the Linear project, parent/sub-issue relationships, dependencies, and links.
- Provide the Notion plan link and Linear epic or issue links.
- Summarize the proposed outcome and any decisions requiring user input.
- State any research or verification limitations.

If Notion or Linear is unavailable, report the exact outstanding work. Do not claim publication succeeded without verification, and do not create implementation issues before the Notion plan is successfully saved.
