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
 * Parse the structured JSON output from Codex.
 *
 * Codex writes a JSON file via `--output-schema` + `-o` containing:
 *   { review_markdown: string, state: object }
 */
function parseOutput(outputDir) {
  const outputPath = path.join(outputDir, 'codex-review-output.json');

  if (!fs.existsSync(outputPath)) {
    console.log(`[codex-review] Output file not found: ${outputPath}`);
    return { reviewBody: null, reviewState: null };
  }

  try {
    const raw = fs.readFileSync(outputPath, 'utf8');
    const output = JSON.parse(raw);

    const reviewBody = output.review_markdown?.trim() || null;
    const reviewState = output.state || null;

    console.log(
      `[codex-review] Parsed output: body=${!!reviewBody} (${reviewBody?.length || 0} chars), state=${!!reviewState}, issues=${reviewState?.open_issues?.length || 0}`
    );

    return { reviewBody, reviewState };
  } catch (e) {
    console.log(`[codex-review] Failed to parse output JSON: ${e.message}`);
    return { reviewBody: null, reviewState: null };
  }
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
