import { describe, it, expect } from "vitest";
import { matchesGitHubTrigger } from "@/lib/routing/matchers";
import type { GitHubTriggerConfig } from "@/lib/automations/types";

describe("matchesGitHubTrigger", () => {
  // ── Exact match ──

  describe("exact event matching", () => {
    it("'push' matches 'push' (no action)", () => {
      const config: GitHubTriggerConfig = { events: ["push"] };
      expect(matchesGitHubTrigger("push", undefined, undefined, config)).toBe(true);
    });

    it("'pull_request.opened' matches exactly", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request.opened"] };
      expect(matchesGitHubTrigger("pull_request", "opened", undefined, config)).toBe(true);
    });
  });

  // ── Prefix match ──

  describe("prefix matching", () => {
    it("'pull_request' matches 'pull_request.opened'", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request"] };
      expect(matchesGitHubTrigger("pull_request", "opened", undefined, config)).toBe(true);
    });

    it("'pull_request' matches 'pull_request.synchronize'", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request"] };
      expect(matchesGitHubTrigger("pull_request", "synchronize", undefined, config)).toBe(true);
    });

    it("'pull_request' matches 'pull_request.closed'", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request"] };
      expect(matchesGitHubTrigger("pull_request", "closed", undefined, config)).toBe(true);
    });
  });

  // ── No match ──

  describe("no match", () => {
    it("'push' does not match 'pull_request.opened'", () => {
      const config: GitHubTriggerConfig = { events: ["push"] };
      expect(matchesGitHubTrigger("pull_request", "opened", undefined, config)).toBe(false);
    });

    it("'pull_request.opened' does not match 'pull_request.closed'", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request.opened"] };
      expect(matchesGitHubTrigger("pull_request", "closed", undefined, config)).toBe(false);
    });

    it("empty events list matches nothing", () => {
      const config: GitHubTriggerConfig = { events: [] };
      expect(matchesGitHubTrigger("push", undefined, undefined, config)).toBe(false);
    });
  });

  // ── Branch filter ──

  describe("branch filter", () => {
    it("matches when ref branch is in branches list", () => {
      const config: GitHubTriggerConfig = {
        events: ["push"],
        branches: ["main", "develop"],
      };
      expect(matchesGitHubTrigger("push", undefined, "refs/heads/main", config)).toBe(true);
    });

    it("rejects when ref branch is NOT in branches list", () => {
      const config: GitHubTriggerConfig = {
        events: ["push"],
        branches: ["main"],
      };
      expect(matchesGitHubTrigger("push", undefined, "refs/heads/feature-x", config)).toBe(false);
    });

    it("strips refs/heads/ prefix for comparison", () => {
      const config: GitHubTriggerConfig = {
        events: ["push"],
        branches: ["develop"],
      };
      expect(matchesGitHubTrigger("push", undefined, "refs/heads/develop", config)).toBe(true);
    });

    it("branch matching is skipped when ref is absent", () => {
      const config: GitHubTriggerConfig = {
        events: ["push"],
        branches: ["main"],
      };
      // When ref is undefined, branch filter is skipped — event matches
      expect(matchesGitHubTrigger("push", undefined, undefined, config)).toBe(true);
    });

    it("all branches match when branches config is not set", () => {
      const config: GitHubTriggerConfig = { events: ["push"] };
      expect(matchesGitHubTrigger("push", undefined, "refs/heads/any-branch", config)).toBe(true);
    });

    it("all branches match when branches config is empty", () => {
      const config: GitHubTriggerConfig = { events: ["push"], branches: [] };
      expect(matchesGitHubTrigger("push", undefined, "refs/heads/any-branch", config)).toBe(true);
    });
  });

  // ── issue_comment.created auto-match for pull_request configs ──

  describe("issue_comment.created auto-match", () => {
    it("matches issue_comment.created when config has 'pull_request' event", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request"] };
      expect(matchesGitHubTrigger("issue_comment", "created", undefined, config)).toBe(true);
    });

    it("matches issue_comment.created when config has 'pull_request.opened'", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request.opened"] };
      expect(matchesGitHubTrigger("issue_comment", "created", undefined, config)).toBe(true);
    });

    it("does NOT match issue_comment.created when config only has 'push'", () => {
      const config: GitHubTriggerConfig = { events: ["push"] };
      expect(matchesGitHubTrigger("issue_comment", "created", undefined, config)).toBe(false);
    });

    it("does NOT match issue_comment.edited even with pull_request events", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request"] };
      expect(matchesGitHubTrigger("issue_comment", "edited", undefined, config)).toBe(false);
    });

    it("does NOT match issue_comment.deleted even with pull_request events", () => {
      const config: GitHubTriggerConfig = { events: ["pull_request"] };
      expect(matchesGitHubTrigger("issue_comment", "deleted", undefined, config)).toBe(false);
    });
  });

  // ── Multiple events in config ──

  describe("multiple events in config", () => {
    it("matches any of multiple configured events", () => {
      const config: GitHubTriggerConfig = {
        events: ["push", "pull_request.opened", "release.published"],
      };
      expect(matchesGitHubTrigger("push", undefined, undefined, config)).toBe(true);
      expect(matchesGitHubTrigger("pull_request", "opened", undefined, config)).toBe(true);
      expect(matchesGitHubTrigger("release", "published", undefined, config)).toBe(true);
      expect(matchesGitHubTrigger("issues", "opened", undefined, config)).toBe(false);
    });
  });
});
