# Agent Evals

Promptfoo evaluation suites for testing Polaris agent behavior. Each suite lives in its own directory with a `promptfooconfig.yaml`.

## When to write an eval

**Write an eval when you find a bug in agent output.** The pattern is:

1. You notice a production issue (reasoning leak, wrong format, missed finding, etc.)
2. You write a regression test in vitest for the parser/postprocessor
3. You write a promptfoo eval that tests the same scenario end-to-end

Vitest tests verify the code works. Promptfoo evals verify the agent produces output the code can handle.

## Quick start

```bash
# Run all parser evals (free, fast, deterministic)
npx promptfoo@latest eval -c evals/review-output/promptfooconfig.yaml --no-cache

# Run agent contract evals (uses OPENAI_API_KEY, GPT-4.1 Mini)
npx promptfoo@latest eval -c evals/review-output/promptfooconfig.agent.yaml --no-cache

# View results in browser
npx promptfoo@latest view
```

## Suites

| Suite | What it tests | Provider |
|-------|--------------|----------|
| `review-output/` | Output parser: reasoning stripping, metadata extraction, header matching | JS → `parseReviewOutput()` |
| `review-output/` (agent) | Agent contract: OpenAI model produces parseable review output | GPT-4.1 Mini |

## Writing a new eval

### From a production bug

This is the most common pattern. You found a bug — now make sure it never happens again.

**Step 1: Capture the failing input.** Get the actual agent output that caused the bug. You can pull it from the production DB:

```bash
# Get the agent's text output for a specific session/pass
./scripts/debug-query.sh "
SELECT string_agg(
  e.payload_json->'params'->'update'->'content'->>'text', ''
  ORDER BY e.event_index
) as text
FROM sandbox_agent.events e
JOIN interactive_sessions s ON s.sdk_session_id = e.session_id
WHERE s.id = '<session-uuid>'
  AND e.sender = 'agent'
  AND e.payload_json->'params'->'update'->>'sessionUpdate' = 'agent_message_chunk'
  AND e.event_index BETWEEN <start> AND <end>
"
```

**Step 2: Anonymize the data.** Replace real repo names, file paths, secrets, and user names with generic equivalents. Keep the structural shape identical — the bug is in the format, not the content.

**Step 3: Write the test case.** Add it to the relevant test YAML:

```yaml
- description: "Regression: <describe the bug>"
  vars:
    raw_output: |
      <anonymized agent output that triggered the bug>
  assert:
    - type: javascript
      value: "<assertion that would have caught the bug>"
      metric: <descriptive_metric_name>
      weight: 3  # higher weight for regression tests
```

**Step 4: Verify it fails before the fix, passes after.** Run the eval against the old code to confirm the test catches the bug, then against the fixed code to confirm it passes.

### Two layers of testing

Every agent behavior issue should be tested at two layers:

| Layer | Tool | What it tests | Speed | Cost |
|-------|------|--------------|-------|------|
| **Parser/code** | vitest | Does the code handle this input correctly? | Fast | Free |
| **Agent contract** | promptfoo | Does the agent produce this input shape? | Slow | $$ |

Parser tests are deterministic — same input always produces same output. Agent contract tests are probabilistic — the agent might produce different output each run. Use deterministic assertions (`contains`, `regex`, `is-json`) for contract tests, not exact string matches.

### Deterministic evals (parser/postprocessor)

Use a custom JS provider that calls the function directly. No LLM calls, no cost, runs in seconds.

```yaml
# promptfooconfig.yaml
prompts:
  - "{{raw_output}}"

providers:
  - "file://providers/my-parser.js"

tests: file://tests/parser-tests.yaml
```

The JS provider writes input to a temp file and runs it through tsx:

```javascript
// providers/my-parser.js
class MyProvider {
  async callApi(prompt) {
    // Write prompt to temp file, run tsx script that imports your function,
    // return JSON.stringify(result)
    return { output: result };
  }
}
module.exports = MyProvider;
```

See `review-output/providers/parser.js` for a working example.

### Agent contract evals

Use the Codex SDK or OpenAI provider to run a real agent and verify output format:

```yaml
# promptfooconfig.agent.yaml
prompts:
  - file://prompts/review.txt

providers:
  - id: "openai:codex-mini"
    config:
      temperature: 0

tests:
  - description: "Agent produces valid metadata block"
    vars:
      diff: |
        <anonymized diff>
    assert:
      - type: contains
        value: "<!-- polaris:metadata -->"
      - type: javascript
        value: |
          // Parse and validate the metadata JSON
          const marker = output.lastIndexOf('<!-- polaris:metadata -->');
          if (marker === -1) return false;
          // ... validate structure
```

### Assertion best practices

**Prefer deterministic assertions** — `contains`, `regex`, `is-json`, `javascript`. These are fast, free, and reproducible.

**Use `javascript` for complex validation** — parse JSON, check nested fields, validate relationships between fields:

```yaml
- type: javascript
  value: |
    const parsed = JSON.parse(output);
    return parsed.metadata.severityCounts.P0 >= 1
      && parsed.metadata.verdict !== 'APPROVE';
  metric: severity_matches_verdict
```

**Use `weight` to prioritize regressions** — give higher weight to assertions that catch known production bugs:

```yaml
- type: javascript
  value: "!JSON.parse(output).commentBody.includes('reasoning text')"
  metric: reasoning_stripped
  weight: 3  # this was a real production bug
```

**Use `metric` for readable reports** — every assertion should have a descriptive metric name that makes sense in the promptfoo viewer.

**Use `llm-rubric` sparingly** — only for subjective quality checks that can't be automated. Always set a grader provider explicitly:

```yaml
defaultTest:
  options:
    provider: openai:gpt-4.1-mini

tests:
  - assert:
      - type: llm-rubric
        value: "The review identifies the SQL injection and explains the concrete attack vector"
```

### Directory structure

```
evals/
  <suite-name>/
    promptfooconfig.yaml        # deterministic tests
    promptfooconfig.agent.yaml  # agent contract tests (optional)
    providers/
      parser.js                 # custom JS provider
    prompts/
      review.txt                # prompt template for agent tests
    tests/
      parser-tests.yaml         # test cases with assertions
      agent-contract-tests.yaml # agent test cases
    results.json                # output (gitignored)
```

### Anonymization checklist

When creating test data from production, replace:
- [ ] Repository owner/name → `acme-org/widget-app`
- [ ] File paths → generic equivalents (`lib/auth/lookup.ts`)
- [ ] Commit SHAs → short hashes (`abc1234`, `def5678`)
- [ ] PR numbers → small numbers (#1, #2)
- [ ] User names → `developer`, `reviewer`
- [ ] API keys / tokens → never include, even redacted
- [ ] Session/job UUIDs → fresh UUIDs or placeholder strings

Keep the structural format identical — change content, not shape.
