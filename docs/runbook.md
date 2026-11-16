# Operations runbook (MDI-223)

This runbook is for whoever receives the `talvio-llm-<stage>-alarms` e-mails. Every signal here is
content-free. Logs and metrics carry ids, counts, codes, money and timings, never resume text,
answers, tokens or signed URLs (design §11). Do not add content to them while debugging.

## Where to look

- **Dashboard.** CloudWatch dashboard `talvio-llm-<stage>` (talvio-terraform-iac `modules/llm/dashboard.tf`). It shows:
  - jobs by outcome;
  - p95 duration and cost per operation;
  - tokens;
  - quota refusals;
  - reconciler results;
  - queues and DLQs.
- **Metrics.** Namespace `Talvio/LLM`, written as embedded metric format lines in the Lambda logs (`src/lib/log.ts`, list in the README). Every metric has a `Stage` dimension. Some also have `Operation`, `Outcome` or `Kind`.
- **Logs.** CloudWatch Logs Insights over the function log groups. Useful queries:
  - `filter event = "run_finished" and outcome = "failed"`;
  - `filter jobId = "<id>"`, which follows one job from admission to its end;
  - `filter event = "model_called" | stats sum(costMicroUsd) by modelId`.
- **User reports** carry the `X-Correlation-Id` of the request. Search the API log group for that `correlationId`. The `job_admitted` line names the job id.

## Alarms

| Alarm              | Means                                                                                                                                  | Do                                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*-dlq-arrivals`   | A work or OCR message failed every delivery.                                                                                           | The DLQ handler already ended the job with a retryable `internal_error`, so the owner can retry it. Find the job id in the `dead_letter` log line, and look at that job's `step_error` lines and the worker's Lambda errors. If many arrive at once, look for a bad deploy.            |
| `*-queue-age`      | Work waits longer than it should.                                                                                                      | Check worker throttles, errors and concurrency, and provider throttling, Claude API or the Bedrock guardrail (`step_error` with `ProviderUnavailableError`). Jobs that wait past their 10-minute deadline are expired by the reconciler.                                               |
| `stuck-jobs`       | The reconciler expired jobs at their deadline.                                                                                         | Something held them: a lost lease, a stalled OCR wait, or retries until the deadline. Check `reconcile_run` and the jobs' last `run_finished` lines. A steady rate is a bug to fix, not to retry away.                                                                                 |
| `reconcile-failed` | The reconciler could not process a job.                                                                                                | Read the `reconcile_failed` lines (error name only) and the reconciler's Lambda errors. Usually DynamoDB throttling or permissions after an infrastructure change.                                                                                                                     |
| `job-failure-rate` | More than 20% of finished jobs failed in 15 minutes.                                                                                   | Break `JobFinished` down by operation on the dashboard. Then group the failed `run_finished` lines by job error code (`model_refusal`, `output_truncated`, `validation_failed`, `budget_exceeded`, `dependency_unavailable`). A jump right after a release means rolling back (below). |
| `result-invalid`   | A model answer passed normalisation but failed the contract check, so nothing was published.                                           | This should never happen. It means a prompt, model or schema regression. Roll back the pipeline release and reproduce with `yarn eval:live`.                                                                                                                                           |
| `spend-70pct`      | Metered spend over the last 24 hours reached 70% of the account's daily ceiling (`ACCOUNT_DAILY_CEILING_MICRO_USD`, USD 5 by default). | Look for one user or one operation driving it with `stats sum(costMicroUsd) by operation`. At 100% the service refuses new paid jobs until the UTC day turns over. Raising the ceiling is an owner decision.                                                                           |
| `ceiling-reached`  | Admission refused a job because of the account ceiling.                                                                                | Users see a retryable 429. Same steps as above.                                                                                                                                                                                                                                        |
| `job-cost-p95`     | The p95 cost per job over an hour is above USD 0.04.                                                                                   | Find the operation on the dashboard. Long inputs push cost up, and the per-job cap of USD 0.05 still holds. A persistent rise after a release fails the release gate, so roll back.                                                                                                    |

## Rolling back

Jobs are pinned at admission to `PIPELINE_RELEASE`. Each release has its own queue, DLQ and executors, so jobs already admitted finish on the release they started on.

1. Redeploy the previous service version. Prompt and model versions are code, so this restores them.
2. If a pipeline release itself is bad, set `PIPELINE_RELEASE` back to the previous one in `serverless.ts` and deploy. Keep the newer release's queue in Terraform until its jobs have drained or expired (at most 10 minutes).

## The Claude API key

Model calls go to the Claude API with a key stored in the SSM SecureString `/<stage>/llm/anthropic-api-key` (MDI-638). Terraform creates the parameter with a placeholder and never manages its value. Only the worker role can read and decrypt it.

- **Setting or rotating it.** An owner writes the key straight into the parameter, from a shell or the console, never in a ticket, chat or file: `aws ssm put-parameter --name /<stage>/llm/anthropic-api-key --type SecureString --overwrite --value "$KEY"`. Running workers keep the key they read until their container is recycled. To switch at once, redeploy the service or update any worker function setting. Revoke the old key in the Claude Console only after the new one is in use.
- **Missing or placeholder key.** Each model step is retried until the job's deadline and then expired. Look for `secret_unavailable` lines (error name only) from the workers.
- **Rejected key** (revoked, wrong workspace, no credit). The call fails with `ProviderRejectedError` and the job ends with `dependency_unavailable`, which the owner can retry. Look for `provider_rejected` lines.

## Replays and retries

Operators do not replay jobs. A failed job with a retryable code is retried by its owner (`POST /v1/jobs/{id}/retry`). That re-checks ownership, the deadline and quota, and replays never bypass them. A repeated Accept in the web app is answered from its receipt (MDI-222). Retries inside a job stay within the job's budget: at most 3 attempts per step and one schema repair per call, all counted in the job's spend ledger.

Any other replay, such as re-driving a DLQ or re-running jobs after an outage, needs the owner's sign-off first.

## Privacy requests

- **Deleting a document, session or job** through the API revokes it at once. Workers check ownership and existence before every paid step and before publishing, and stored objects are removed. Lifecycle and TTL catch anything left over:
  - uploads after 24 hours;
  - results, sessions and documents after 7 days;
  - job metadata after 30 days.
- **Account deletion** in the web app ends access at once, because tokens for a deleted account are refused. The service's own data then expires on the retention schedule above.
- **Customer documents.** Never copy one into a fixture, a ticket or a log. The evaluation set is synthetic (docs/evaluation.md).

## Before production

These decisions need the owner's sign-off before production. They are not runbook steps:

- **Model and provider:** Claude Haiku 5.5 through the Claude API for every model call (MDI-638), and the input guardrail on Bedrock in us-west-1. Resume and job description text goes to Anthropic; the privacy copy must say so.
- **Prices and the ceiling:** the prices in `src/lib/model/pricing.ts`, and the account daily ceiling.
- **Retention and consent:** the retention periods, and the privacy copy that describes them (web).
- **Operator replay policy:** described above.
- **Release evaluation:** a passing `yarn eval:live` report, with every question rated, for the release that goes live.
