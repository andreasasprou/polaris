#!/usr/bin/env bash
#
# Axiom IaC — Sandbox Lifecycle Dashboard & Monitors
#
# Creates a dashboard + monitors for sandbox lifecycle observability.
# Requires AXIOM_TOKEN env var (API token or PAT).
# Optionally set AXIOM_ORG_ID for PAT auth and AXIOM_NOTIFIER_ID
# to attach alerts to an existing notifier (Slack, email, etc).
#
# Usage:
#   AXIOM_TOKEN=xaat-xxx ./scripts/axiom-sandbox-observability.sh
#   AXIOM_TOKEN=xaat-xxx AXIOM_NOTIFIER_ID=not_xxx ./scripts/axiom-sandbox-observability.sh
#
# Idempotent: uses fixed UIDs so re-running updates rather than duplicates.
#

set -euo pipefail

API="https://api.axiom.co/v2"
TOKEN="${AXIOM_TOKEN:?Set AXIOM_TOKEN}"
ORG_ID="${AXIOM_ORG_ID:-}"
NOTIFIER_ID="${AXIOM_NOTIFIER_ID:-}"

auth_headers=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")
if [[ -n "$ORG_ID" ]]; then
  auth_headers+=(-H "x-axiom-org-id: ${ORG_ID}")
fi

# Helper: POST to Axiom API, print response
axiom_post() {
  local endpoint="$1"
  local data="$2"
  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "${API}${endpoint}" "${auth_headers[@]}" -d "$data")
  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
    echo "  OK ($http_code)"
  elif [[ "$http_code" == "409" ]]; then
    echo "  Already exists (409) — skipping"
  else
    echo "  FAILED ($http_code): $body" >&2
    return 1
  fi
}

# Helper: build notifierIds JSON array
notifier_ids="[]"
if [[ -n "$NOTIFIER_ID" ]]; then
  notifier_ids="[\"${NOTIFIER_ID}\"]"
fi

echo "=== Creating Axiom Monitors ==="

echo -n "1/5 Long-running sandboxes (>1h)..."
axiom_post "/monitors" "$(cat <<ENDJSON
{
  "name": "Sandbox: Long-running (>1h)",
  "description": "At least one sandbox has been running for over 1 hour. Check if it's stuck or legitimate.",
  "type": "Threshold",
  "aplQuery": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where toint(p.sandbox_gauge.over1h) > 0 | summarize count()",
  "operator": "Above",
  "threshold": 0,
  "intervalMinutes": 10,
  "rangeMinutes": 10,
  "notifierIds": ${notifier_ids},
  "triggerFromNRuns": 2
}
ENDJSON
)"

echo -n "2/5 High sandbox count (>20)..."
axiom_post "/monitors" "$(cat <<ENDJSON
{
  "name": "Sandbox: High count (>20 live)",
  "description": "More than 20 sandboxes running simultaneously. Possible leak or burst.",
  "type": "Threshold",
  "aplQuery": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | summarize max(toint(p.sandbox_gauge.liveRuntimes))",
  "operator": "Above",
  "threshold": 20,
  "intervalMinutes": 10,
  "rangeMinutes": 10,
  "notifierIds": ${notifier_ids},
  "triggerFromNRuns": 2
}
ENDJSON
)"

echo -n "3/5 Provider janitor killing unknowns..."
axiom_post "/monitors" "$(cat <<ENDJSON
{
  "name": "Sandbox: Janitor stopped unknown sandboxes",
  "description": "Provider janitor found sandboxes in Vercel with no DB record. Indicates a provisioning crash or race condition.",
  "type": "MatchEvent",
  "aplQuery": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where toint(p.sweep.providerJanitor.unknownStopped) > 0",
  "intervalMinutes": 5,
  "rangeMinutes": 5,
  "notifierIds": ${notifier_ids}
}
ENDJSON
)"

echo -n "4/5 Controller orphan spike (>3)..."
axiom_post "/monitors" "$(cat <<ENDJSON
{
  "name": "Sandbox: Controller destroying many orphans",
  "description": "Runtime controller destroyed >3 orphaned sandboxes in one cycle. Something upstream is leaking claims.",
  "type": "Threshold",
  "aplQuery": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | summarize max(toint(p.sweep.runtimeController.destroyedOrphans))",
  "operator": "Above",
  "threshold": 3,
  "intervalMinutes": 5,
  "rangeMinutes": 5,
  "notifierIds": ${notifier_ids},
  "triggerFromNRuns": 1
}
ENDJSON
)"

echo -n "5/5 Sandbox exceeded 8h (CRITICAL)..."
axiom_post "/monitors" "$(cat <<ENDJSON
{
  "name": "CRITICAL: Sandbox exceeded 8h lifetime",
  "description": "A sandbox has been running for over 8 hours. Hard TTL enforcement may have failed. Immediate investigation required.",
  "type": "MatchEvent",
  "aplQuery": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where todouble(p.sandbox_gauge.maxAgeMs) > 28800000",
  "intervalMinutes": 5,
  "rangeMinutes": 5,
  "notifierIds": ${notifier_ids},
  "notifyEveryRun": true
}
ENDJSON
)"

echo ""
echo "=== Creating Axiom Dashboard ==="

echo -n "Sandbox Lifecycle dashboard..."
axiom_post "/dashboards" "$(cat <<ENDJSON
{
  "uid": "polaris-sandbox-lifecycle",
  "version": 1,
  "message": "IaC: sandbox lifecycle observability",
  "dashboard": {
    "name": "Sandbox Lifecycle",
    "description": "Sandbox provisioning, claims, controller actions, and cost tracking. Created by scripts/axiom-sandbox-observability.sh",
    "owner": "X-AXIOM-EVERYONE",
    "refreshTime": 60,
    "schemaVersion": 2,
    "timeWindowStart": "qr-now-6h",
    "timeWindowEnd": "qr-now",
    "charts": [
      {
        "id": "live-count",
        "type": "TimeSeries",
        "name": "Live Sandboxes",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sandbox_gauge) | project _time, liveRuntimes = toint(p.sandbox_gauge.liveRuntimes) | summarize max(liveRuntimes) by bin_auto(_time)",
          "queryOptions": { "displayNull": "zero", "timeSeriesVariant": "area", "timeSeriesView": "charts" }
        }
      },
      {
        "id": "max-age",
        "type": "TimeSeries",
        "name": "Max Sandbox Age (minutes)",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sandbox_gauge) | project _time, maxAgeMin = todouble(p.sandbox_gauge.maxAgeMs) / 60000 | summarize max(maxAgeMin) by bin_auto(_time)",
          "queryOptions": { "displayNull": "zero", "timeSeriesVariant": "line", "timeSeriesView": "charts" }
        }
      },
      {
        "id": "stat-live",
        "type": "Statistic",
        "name": "Live Now",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sandbox_gauge) | summarize arg_max(_time, toint(p.sandbox_gauge.liveRuntimes)) | project max_"
        },
        "colorScheme": "Blue",
        "warningThreshold": "Above",
        "warningThresholdValue": "10",
        "errorThreshold": "Above",
        "errorThresholdValue": "20"
      },
      {
        "id": "stat-over1h",
        "type": "Statistic",
        "name": "Over 1h",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sandbox_gauge) | summarize arg_max(_time, toint(p.sandbox_gauge.over1h)) | project max_"
        },
        "colorScheme": "Red",
        "warningThreshold": "Above",
        "warningThresholdValue": "0",
        "errorThreshold": "Above",
        "errorThresholdValue": "3"
      },
      {
        "id": "controller-actions",
        "type": "TimeSeries",
        "name": "Controller Actions",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sweep.runtimeController) | project _time, destroyed = toint(p.sweep.runtimeController.destroyedOrphans), hibernated = toint(p.sweep.runtimeController.hibernatedOrphans), ttl = toint(p.sweep.runtimeController.destroyedTtlExceeded), expired = toint(p.sweep.runtimeController.expiredClaims) | summarize sum(destroyed), sum(hibernated), sum(ttl), sum(expired) by bin_auto(_time)",
          "queryOptions": { "displayNull": "zero", "timeSeriesVariant": "bars", "timeSeriesView": "charts" }
        }
      },
      {
        "id": "janitor-actions",
        "type": "TimeSeries",
        "name": "Provider Janitor",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sweep.providerJanitor) | project _time, vercelRunning = toint(p.sweep.providerJanitor.vercelRunning), unknownStopped = toint(p.sweep.providerJanitor.unknownStopped), errors = toint(p.sweep.providerJanitor.errors) | summarize sum(vercelRunning), sum(unknownStopped), sum(errors) by bin_auto(_time)",
          "queryOptions": { "displayNull": "zero", "timeSeriesVariant": "bars", "timeSeriesView": "charts" }
        }
      },
      {
        "id": "sweep-health",
        "type": "TimeSeries",
        "name": "Sweeper Health",
        "query": {
          "apl": "['vercel'] | where ['request.path'] == \"/api/cron/sweeper\" | extend p = parse_json(message) | where isnotnull(p.sweep) | project _time, timedOut = toint(p.sweep.timedOut), staleHealed = toint(p.sweep.staleSessionsHealed), retried = toint(p.sweep.retriedJobs), locksReleased = toint(p.sweep.staleLocksReleased) | summarize sum(timedOut), sum(staleHealed), sum(retried), sum(locksReleased) by bin_auto(_time)",
          "queryOptions": { "displayNull": "zero", "timeSeriesVariant": "bars", "timeSeriesView": "charts" }
        }
      },
      {
        "id": "monitors",
        "type": "MonitorList",
        "name": "Active Alerts"
      }
    ],
    "layout": [
      { "i": "stat-live",          "x": 0,  "y": 0, "w": 3,  "h": 3, "minW": 2, "minH": 2 },
      { "i": "stat-over1h",        "x": 3,  "y": 0, "w": 3,  "h": 3, "minW": 2, "minH": 2 },
      { "i": "monitors",           "x": 6,  "y": 0, "w": 6,  "h": 3, "minW": 3, "minH": 2 },
      { "i": "live-count",         "x": 0,  "y": 3, "w": 6,  "h": 4, "minW": 3, "minH": 3 },
      { "i": "max-age",            "x": 6,  "y": 3, "w": 6,  "h": 4, "minW": 3, "minH": 3 },
      { "i": "controller-actions",  "x": 0,  "y": 7, "w": 6,  "h": 4, "minW": 3, "minH": 3 },
      { "i": "janitor-actions",     "x": 6,  "y": 7, "w": 6,  "h": 4, "minW": 3, "minH": 3 },
      { "i": "sweep-health",        "x": 0, "y": 11, "w": 12, "h": 4, "minW": 3, "minH": 3 }
    ]
  }
}
ENDJSON
)"

echo ""
echo "=== Done ==="
echo "View dashboard at: https://app.axiom.co/polaris/dashboards/polaris-sandbox-lifecycle"
