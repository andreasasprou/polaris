// Codex Code Review — Core logic for state management, posting, and prompt building.
// This file is loaded by actions/github-script steps in the workflow.
'use strict';

const fs = require('fs');
const path = require('path');

// ─── Comment Markers ──────────────────────────────────────────────────────────
// These HTML comments identify bot-managed comments on the PR.
const MARKERS = {
  state: 'codex-review:state:v1:base64',
  review: 'codex-review:review',
  stale: 'codex-review:stale',
};

// ─── State Management ─────────────────────────────────────────────────────────

/**
 * Load previous review state from GitHub PR comments.
 *
 * State is stored as base64-encoded JSON inside a hidden HTML comment.
 * The review comment is identified by a marker and must not be stale.
 *
 * @returns {{ stateCommentId, reviewCommentId, lastReviewedSha, reviewCount, state, previousReviewBody }}
 */
async function loadPreviousState({ github, owner, repo, prNumber, reset }) {
  const result = {
    stateCommentId: null,
    reviewCommentId: null,
    lastReviewedSha: null,
    reviewCount: 0,
    state: null,
    previousReviewBody: null,
  };

  if (reset) {
    console.log('Reset requested — ignoring previous state');
    return result;
  }

  const comments = await github.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
    sort: 'updated',
    direction: 'desc',
  });

  for (const comment of comments.data) {
    if (comment.user?.login !== 'github-actions[bot]') continue;
    const body = comment.body || '';

    // Find latest non-stale review comment
    if (
      !result.reviewCommentId &&
      body.includes(`<!-- ${MARKERS.review} -->`) &&
      !body.includes(`<!-- ${MARKERS.stale} -->`)
    ) {
      result.reviewCommentId = comment.id;
      result.previousReviewBody = body;
    }

    // Find state comment
    if (!result.stateCommentId && body.includes(MARKERS.state)) {
      result.stateCommentId = comment.id;
      const escaped = MARKERS.state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `<!--\\s*${escaped}\\s*\\n([A-Za-z0-9+/=\\n]+)\\n\\s*-->`
      );
      const match = body.match(re);
      if (match?.[1]) {
        try {
          const json = Buffer.from(
            match[1].replace(/\s+/g, ''),
            'base64'
          ).toString('utf8');
          result.state = JSON.parse(json);
          result.lastReviewedSha =
            result.state.last_reviewed_head_sha || null;
          result.reviewCount = result.state.review_count || 0;
          console.log(
            `Loaded state: review_count=${result.reviewCount}, last_sha=${result.lastReviewedSha?.slice(0, 8) || 'none'}`
          );
        } catch (e) {
          console.log(`Failed to parse state: ${e.message}`);
        }
      }
    }

    if (result.stateCommentId && result.reviewCommentId) break;
  }

  return result;
}

/**
 * Persist review state as a hidden comment on the PR.
 * Creates a new comment or updates the existing one.
 */
async function persistState({
  github,
  owner,
  repo,
  prNumber,
  state,
  stateCommentId,
}) {
  const b64 = Buffer.from(JSON.stringify(state)).toString('base64');
  const openCount = (state.open_issues || []).length;
  const body = [
    `<details>`,
    `<summary>Codex Review State (do not edit)</summary>\n`,
    `- Last reviewed: \`${(state.last_reviewed_head_sha || '').slice(0, 8) || 'none'}\``,
    `- Reviews completed: ${state.review_count || 0}`,
    `- Open issues: ${openCount}`,
    `\n</details>`,
    `<!-- ${MARKERS.state}`,
    b64,
    `-->`,
  ].join('\n');

  if (stateCommentId) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: stateCommentId,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}

// ─── Stale Comment Management ─────────────────────────────────────────────────

/**
 * Mark a previous review comment as stale.
 * Wraps the original body in a collapsed <details> with a "Superseded" banner.
 */
async function markCommentStale({
  github,
  owner,
  repo,
  commentId,
  newReviewNumber,
}) {
  const comment = await github.rest.issues.getComment({
    owner,
    repo,
    comment_id: commentId,
  });
  const body = comment.data.body || '';
  if (body.includes(`<!-- ${MARKERS.stale} -->`)) return; // Already stale

  const staleBody = [
    `<!-- ${MARKERS.stale} -->`,
    `> **Superseded** — See Review #${newReviewNumber} below for the latest review.\n`,
    `<details><summary>Previous review (collapsed)</summary>\n`,
    body,
    `\n</details>`,
  ].join('\n');

  await github.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: staleBody,
  });
}

// ─── Review Posting ───────────────────────────────────────────────────────────

async function postReviewComment({ github, owner, repo, prNumber, body }) {
  const markedBody = `<!-- ${MARKERS.review} -->\n${body}`;
  const comment = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: markedBody,
  });
  return comment.data.id;
}

// ─── Check Run ────────────────────────────────────────────────────────────────

async function updateCheckRun({
  github,
  owner,
  repo,
  checkId,
  conclusion,
  title,
  summary,
}) {
  await github.rest.checks.update({
    owner,
    repo,
    check_run_id: checkId,
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    output: { title, summary: summary.slice(0, 65535) },
  });
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

/**
 * Build the review prompt by interpolating variables into the template.
 * Template uses ${VAR_NAME} placeholders.
 */
function buildPrompt(vars) {
  const templatePath = path.join(__dirname, 'prompt.md');
  let template = fs.readFileSync(templatePath, 'utf8');

  for (const [key, value] of Object.entries(vars)) {
    // Use split+join for global replace (safe with special regex chars in values)
    template = template.split(`\${${key}}`).join(String(value ?? ''));
  }

  return template;
}

/**
 * Load repository review guidelines (AGENTS.md, REVIEW_GUIDELINES.md).
 * Returns concatenated content or a placeholder message.
 */
function loadGuidelines(repoRoot) {
  const files = ['AGENTS.md', 'REVIEW_GUIDELINES.md'];
  const sections = [];

  for (const file of files) {
    const filePath = path.join(repoRoot, file);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.trim()) {
          sections.push(`### ${file}\n\n${content.trim()}`);
        }
      }
    } catch {
      /* skip missing files */
    }
  }

  return sections.length > 0
    ? sections.join('\n\n---\n\n')
    : '_No repo guidelines found. Add AGENTS.md or REVIEW_GUIDELINES.md to your repo root for project-specific review rules._';
}

// ─── Output Parsing ───────────────────────────────────────────────────────────

/**
 * Parse review output from the Codex NDJSON stream.
 *
 * Codex's sandbox blocks filesystem writes, so the review is output as the
 * agent's final text message. We extract:
 * 1. The review markdown (everything from "## Codex Review" to the state marker)
 * 2. The state JSON (between codex-review:state-json markers)
 *
 * Falls back to reading /tmp files if they exist (for local testing).
 */
function parseOutput(outputDir) {
  let reviewBody = null;
  let reviewState = null;

  // Try /tmp files first (works in local testing)
  const reviewPath = path.join(outputDir, 'codex-review.md');
  if (fs.existsSync(reviewPath)) {
    const content = fs.readFileSync(reviewPath, 'utf8').trim();
    if (content) reviewBody = content;
  }
  const statePath = path.join(outputDir, 'codex-review-state.json');
  if (fs.existsSync(statePath)) {
    try {
      reviewState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
      console.log(`Warning: Failed to parse state JSON from file: ${e.message}`);
    }
  }

  // If files weren't written, extract from NDJSON output
  if (!reviewBody) {
    const ndjsonPath = path.join(outputDir, 'codex-output.json');
    console.log(`[codex-review] NDJSON path: ${ndjsonPath}, exists: ${fs.existsSync(ndjsonPath)}`);
    if (fs.existsSync(ndjsonPath)) {
      const ndjsonContent = fs.readFileSync(ndjsonPath, 'utf8');
      console.log(`[codex-review] NDJSON size: ${ndjsonContent.length} bytes, lines: ${ndjsonContent.split('\n').length}`);
      const result = extractFromNdjson(ndjsonContent);
      console.log(`[codex-review] NDJSON extraction: body=${!!result.reviewBody} (${result.reviewBody?.length || 0} chars), state=${!!result.reviewState}`);
      if (result.reviewBody) reviewBody = result.reviewBody;
      if (result.reviewState) reviewState = result.reviewState;
    }
  }

  return { reviewBody, reviewState };
}

/**
 * Extract review markdown and state JSON from Codex NDJSON output.
 *
 * Scans all agent_message items for text containing the review header
 * ("## Codex Review"). Takes the last (most complete) match.
 * Extracts state JSON from <!-- codex-review:state-json --> markers
 * or from a standalone ```json block after the review.
 */
function extractFromNdjson(ndjsonContent) {
  let reviewBody = null;
  let reviewState = null;

  const lines = ndjsonContent.split('\n').filter(Boolean);

  // Collect all agent message texts
  const agentTexts = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      // Direct agent messages
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
        agentTexts.push(event.item.text);
      }
      // Sub-agent messages (collab_tool_call results contain agent state messages)
      if (event.type === 'item.completed' && event.item?.type === 'collab_tool_call' && event.item?.agents_states) {
        for (const state of Object.values(event.item.agents_states)) {
          if (state.message) agentTexts.push(state.message);
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  // Find the best (longest) text containing the review header
  let bestText = null;
  for (const text of agentTexts) {
    if (text.includes('## Codex Review') && text.includes('Verdict:')) {
      if (!bestText || text.length > bestText.length) {
        bestText = text;
      }
    }
  }

  if (!bestText) return { reviewBody: null, reviewState: null };

  // Extract review body: from "## Codex Review" to the state marker or end
  const reviewStart = bestText.indexOf('## Codex Review');
  if (reviewStart === -1) return { reviewBody: null, reviewState: null };

  // Check for state JSON marker
  const stateMarker = '<!-- codex-review:state-json -->';
  const stateMarkerEnd = '<!-- /codex-review:state-json -->';
  const stateStart = bestText.indexOf(stateMarker, reviewStart);

  if (stateStart !== -1) {
    // Review body is everything from header to state marker
    reviewBody = bestText.slice(reviewStart, stateStart).trim();

    // State JSON is between the markers, inside a ```json block
    const stateEnd = bestText.indexOf(stateMarkerEnd, stateStart);
    const stateBlock = stateEnd !== -1
      ? bestText.slice(stateStart + stateMarker.length, stateEnd)
      : bestText.slice(stateStart + stateMarker.length);

    const jsonMatch = stateBlock.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (jsonMatch) {
      try {
        reviewState = JSON.parse(jsonMatch[1].trim());
      } catch (e) {
        console.log(`Warning: Failed to parse state JSON from marker: ${e.message}`);
      }
    }
  } else {
    // No state marker — try to split on the last ```json block
    const jsonBlockRegex = /```json\s*\n(\{[\s\S]*?"schema_version"[\s\S]*?\})\s*\n```/g;
    let lastJsonMatch = null;
    let match;
    while ((match = jsonBlockRegex.exec(bestText)) !== null) {
      lastJsonMatch = match;
    }

    if (lastJsonMatch) {
      reviewBody = bestText.slice(reviewStart, lastJsonMatch.index).trim();
      try {
        reviewState = JSON.parse(lastJsonMatch[1].trim());
      } catch (e) {
        console.log(`Warning: Failed to parse state JSON from block: ${e.message}`);
      }
    } else {
      reviewBody = bestText.slice(reviewStart).trim();
    }
  }

  // Clean up: remove markdown code fence wrappers if the review was inside one
  if (reviewBody.startsWith('```markdown')) {
    reviewBody = reviewBody.replace(/^```markdown\s*\n/, '').replace(/\n```\s*$/, '');
  }
  if (reviewBody.startsWith('```')) {
    reviewBody = reviewBody.replace(/^```\s*\n/, '').replace(/\n```\s*$/, '');
  }

  return { reviewBody, reviewState };
}

function extractVerdict(body) {
  if (!body) return 'ERROR';
  const match = body.match(/Verdict:\s*(BLOCK|ATTENTION|OK)/i);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

// ─── Command Parser ───────────────────────────────────────────────────────────

/**
 * Parse /codex-review command options from a comment body.
 * Supports: full, reset, --since <sha>, --since=<sha>
 */
function parseCommand(commentBody) {
  const result = { forceFullReview: false, resetState: false, sinceSha: '' };
  if (!commentBody) return result;

  const tokens = commentBody.trim().split(/\s+/).slice(1); // Skip "/codex-review"
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (['full', '--full', 'all', '--all'].includes(token)) {
      result.forceFullReview = true;
    } else if (['reset', '--reset'].includes(token)) {
      result.resetState = true;
    } else if (token === '--since' && /^[0-9a-f]{7,40}$/i.test(tokens[i + 1] || '')) {
      result.sinceSha = tokens[++i];
    } else {
      const match = token.match(/^--since=([0-9a-f]{7,40})$/i);
      if (match) result.sinceSha = match[1];
    }
  }

  return result;
}

// ─── Post-Processing Orchestrator ─────────────────────────────────────────────

/**
 * Orchestrate all post-review actions with error isolation.
 * Each step is independent — failures don't cascade.
 *
 * Order: post comment → persist state → mark stale → update check
 * This prioritizes user-visible output over internal bookkeeping.
 */
async function postResults({
  github,
  owner,
  repo,
  prNumber,
  checkId,
  previousState,
  outputDir,
}) {
  const log = (msg) => console.log(`[codex-review] ${msg}`);
  const { reviewBody, reviewState } = parseOutput(outputDir);
  const reviewNumber = (previousState?.reviewCount || 0) + 1;

  if (!reviewBody) {
    log('No review output generated');
    if (checkId) {
      await updateCheckRun({
        github,
        owner,
        repo,
        checkId,
        conclusion: 'failure',
        title: 'Review Failed',
        summary:
          'Codex did not generate a review. Check the workflow logs for details.',
      });
    }
    return { verdict: 'ERROR', commentId: null };
  }

  const verdict = extractVerdict(reviewBody);

  // Step 1: Post new review comment (most important — do first)
  let newCommentId = null;
  try {
    newCommentId = await postReviewComment({
      github,
      owner,
      repo,
      prNumber,
      body: reviewBody,
    });
    log(`Posted review #${reviewNumber} (comment ${newCommentId})`);
  } catch (e) {
    log(`Failed to post comment: ${e.message}`);
  }

  // Step 2: Persist state (important for continuity)
  if (reviewState) {
    reviewState.review_count = reviewNumber;
    try {
      await persistState({
        github,
        owner,
        repo,
        prNumber,
        state: reviewState,
        stateCommentId: previousState?.stateCommentId,
      });
      log('State persisted');
    } catch (e) {
      log(`Failed to persist state: ${e.message}`);
    }
  }

  // Step 3: Mark previous review as stale (cosmetic)
  if (previousState?.reviewCommentId && newCommentId) {
    try {
      await markCommentStale({
        github,
        owner,
        repo,
        commentId: previousState.reviewCommentId,
        newReviewNumber: reviewNumber,
      });
      log('Previous review marked stale');
    } catch (e) {
      log(`Failed to mark stale: ${e.message}`);
    }
  }

  // Step 4: Update check run (least critical)
  if (checkId) {
    try {
      await updateCheckRun({
        github,
        owner,
        repo,
        checkId,
        conclusion: verdict === 'BLOCK' ? 'failure' : 'success',
        title: `Review #${reviewNumber}: ${verdict}`,
        summary: `Verdict: **${verdict}**`,
      });
      log(`Check updated: ${verdict}`);
    } catch (e) {
      log(`Failed to update check: ${e.message}`);
    }
  }

  return { verdict, commentId: newCommentId };
}

module.exports = {
  loadPreviousState,
  persistState,
  markCommentStale,
  postReviewComment,
  updateCheckRun,
  buildPrompt,
  loadGuidelines,
  parseOutput,
  extractVerdict,
  parseCommand,
  postResults,
  MARKERS,
};
