---
name: observe
description: Debug production issues in Polaris using Axiom logs and the production database. Use this skill whenever you need to investigate stuck sessions, failed reviews, missing callbacks, agent behavior, or any production state — including when the user asks "why is this stuck", "check the logs", "what happened to this review", "debug this session", "check production", or shares a plrs.sh session/run URL. Also use when you need to understand what an agent actually said or did during a review, or when tracing a webhook through dispatch to callback completion.
---

# Polaris Production Observability

You have two data sources for debugging production issues. Use them systematically — don't guess. Start with identifiers, trace through logs, then check state.

## Data Sources

### 1. Axiom (request logs via evlog)

Query with `mcp__axiom__queryDataset`. The dataset is `vercel`. Always set `startTime`/`endTime`.

The `message` field is a JSON string containing structured wide-event context. Key nested fields: `webhook.*`, `router.*`, `dispatch.*`, `callback.*`, `sweep.*`, `lifecycle.*`, `timing.*`, `postprocess.*`.

**Find a webhook dispatch:**
```apl
['vercel'] | where ['request.path'] == "/api/webhooks/github"
  | where ['message'] contains "<prNumber or headSha or sessionId>"
  | project _time, message | sort by _time desc | take 5
```

**Find callbacks for a job:**
```apl
['vercel'] | where ['request.path'] == "/api/callbacks"
  | where ['message'] contains "<jobId>"
  | project _time, message | sort by _time desc | take 5
```

**Find prompt_complete callbacks (review completions):**
```apl
['vercel'] | where ['request.path'] == "/api/callbacks"
  | where ['message'] contains "prompt_complete"
  | where _time > todatetime("2026-03-22T14:00:00Z")
  | project _time, message | sort by _time desc | take 5
```

**Find errors:**
```apl
['vercel'] | where ['level'] == "error"
  | where _time > ago(1h)
  | project _time, message | take 10
```

**Callback activity over time (are callbacks arriving?):**
```apl
['vercel'] | where ['request.path'] == "/api/callbacks"
  | summarize count() by bin(_time, 5m) | sort by _time asc
```

**Key fields in dispatch logs:**
- `dispatch.jobId` — the job ID (use to find callbacks)
- `dispatch.agent` — which agent was used (claude/codex)
- `dispatch.attempt_1_response.status` — 202 = accepted, anything else = problem
- `dispatch.attempt_1_health.alive` — was the sandbox healthy?
- `lifecycle.sessionId` — the interactive session ID
- `lifecycle.restoreSource` — cold (new sandbox) or warm (reused)
- `timing.totalMs` — sandbox provisioning time

**Key fields in callback logs:**
- `callback.callbackType` — prompt_complete, session_events, prompt_failed
- `proxyMetrics.promptExecutionMs` — how long the agent ran
- `proxyMetrics.eventCount` — number of agent events
- `proxyMetrics.resumeType` — fresh or text_replay
- `postprocess.threadsResolved` — number of inline threads resolved
- `postprocess.inlineReplied` — number of inline comments posted

### 2. Production Database

Query with `./scripts/debug-query.sh "SQL"`. Credentials come from 1Password at runtime — never ask for or display them.

**Agent transcript** (`sandbox_agent.events`):
```sql
-- Count events for a session
SELECT count(*) FROM sandbox_agent.events
WHERE session_id = (
  SELECT sdk_session_id FROM interactive_sessions WHERE id = '<session-uuid>'
);

-- Get agent text chunks (assembled review output)
SELECT string_agg(
  e.payload_json->'params'->'update'->'content'->>'text', ''
  ORDER BY e.event_index
) as text
FROM sandbox_agent.events e
JOIN interactive_sessions s ON s.sdk_session_id = e.session_id
WHERE s.id = '<session-uuid>'
  AND e.sender = 'agent'
  AND e.payload_json->'params'->'update'->>'sessionUpdate' = 'agent_message_chunk'
  AND e.event_index BETWEEN <start> AND <end>;

-- Find metadata markers (one per review pass)
SELECT e.event_index,
  substring(e.payload_json::text from 1 for 200) as preview
FROM sandbox_agent.events e
JOIN interactive_sessions s ON s.sdk_session_id = e.session_id
WHERE s.id = '<session-uuid>'
  AND e.payload_json::text LIKE '%polaris:metadata%'
ORDER BY e.event_index ASC;

-- Find specific tokens in agent output
SELECT e.event_index,
  e.payload_json->'params'->'update'->'content'->>'text' as chunk
FROM sandbox_agent.events e
JOIN interactive_sessions s ON s.sdk_session_id = e.session_id
WHERE s.id = '<session-uuid>'
  AND e.sender = 'agent'
  AND e.payload_json->'params'->'update'->>'sessionUpdate' = 'agent_message_chunk'
  AND e.payload_json->'params'->'update'->'content'->>'text' LIKE '%<search-term>%'
ORDER BY e.event_index ASC;
```

**Session state:**
```sql
SELECT id, status, agent_type, sdk_session_id, sandbox_base_url, sandbox_id,
  created_at, updated_at
FROM interactive_sessions WHERE id = '<session-uuid>';
```

**Automation session (review metadata):**
```sql
SELECT id, automation_id, status, review_lock_job_id,
  metadata->>'prNumber' as pr_number,
  metadata->>'lastReviewedSha' as last_reviewed_sha,
  metadata->'pendingReviewRequest' as pending_request,
  metadata->'reviewState' as review_state
FROM automation_sessions WHERE id = '<session-uuid>';
```

**Job lifecycle:**
```sql
SELECT id, type, status, session_id, automation_run_id,
  created_at, timeout_at,
  payload->>'prNumber' as pr_number,
  payload->>'checkRunId' as check_run_id
FROM jobs WHERE session_id = '<session-uuid>'
ORDER BY created_at DESC LIMIT 5;
```

**Automation run status:**
```sql
SELECT id, status, summary, error, started_at, completed_at
FROM automation_runs WHERE id = '<run-uuid>';
```

## Debugging Workflows

### Stuck Session

A session shows "active" in the UI but nothing is happening.

1. **Get identifiers.** Extract the interactive session ID from the URL (plrs.sh/sessions/<id>) or from a PR number via Axiom.
2. **Check Axiom** for the latest dispatch. Did it get a 202? Did the callback arrive?
3. **Check the job** in the DB. Is it still `pending`/`running` or did it time out?
4. **Check the session status** in the DB. Is it `active` with no running job? (sweeper should heal this)
5. **Check for pending review requests** on the automation session. Was a queued review lost?

### Failed Review

The GitHub check shows "failure" or the review never posted.

1. **Check the automation run** in the DB for the error message.
2. **Check Axiom** for the dispatch — did config validation fail? Did the sandbox reject the prompt?
3. **Check the job attempts** — did all attempts fail? What errors?
4. **Check callbacks** — did a prompt_failed callback arrive?

### Missing Callback

Dispatch returned 202 but no callback arrived.

1. **Check Axiom** callback path for the jobId — is there any activity?
2. **Check the job** in the DB — is it stuck in `accepted`/`running`?
3. **Check timing** — the job has a `timeout_at`. Has the sweeper not run yet?
4. The sandbox may have died silently. The sweeper heals this via `sweepTimedOutJobs`.

### Agent Behavior Analysis

Understanding what the agent actually did during a review.

1. **Find the session** and its SDK session ID.
2. **Count events** to get the scale.
3. **Find metadata markers** — each `polaris:metadata` marks a review pass boundary.
4. **Extract text between markers** to read what the agent wrote for each pass.
5. **Check resolvedIssueIds** in the metadata JSON to see if it tracked issue continuity.
6. **Check tool calls** near a specific event_index to see what the agent was reading/running.

## Important Notes

- Axiom has request-level logs (dispatch, callback, sweeper). The DB has state and agent events.
- The `message` field in Axiom is a JSON string — use `contains` for searching, not field access.
- Agent events are token-level chunks. Use `string_agg(...ORDER BY event_index)` to reassemble text.
- The `sandbox_agent.events` table uses a separate schema. The `debug_reader` role needs `GRANT USAGE ON SCHEMA sandbox_agent` to access it.
- Never display or log database credentials. The script handles auth via 1Password.
- Always narrow time ranges in Axiom queries to avoid scanning too much data.
