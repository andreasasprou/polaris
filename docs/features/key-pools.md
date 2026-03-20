# Key Pools

Key Pools let you group multiple API keys for the same provider and automatically rotate through them. Instead of relying on a single key that can hit rate limits or quota caps, the system distributes usage across all keys in the pool.

## How it works

1. **Add your API keys** in Settings > API Keys as usual (e.g., three Anthropic keys labeled `team-1`, `team-2`, `team-3`)
2. **Create a Key Pool** on the same page — give it a name and select the provider (Anthropic or OpenAI)
3. **Add keys to the pool** — expand the pool card and add your existing keys
4. **Use the pool** in your automations or sessions — the API Key dropdown now shows both Key Pools and individual keys

When a new sandbox is provisioned (new automation run, new session, or session recovery), the system picks the least-recently-used key from the pool. This distributes load evenly across all your keys without any manual intervention.

## When keys rotate

Rotation happens at **sandbox provisioning time**, not on every prompt. This means:

| Scenario | Rotates? |
|----------|----------|
| New automation run | Yes |
| New session | Yes |
| Sending a prompt to a live session | No (reuses the same key) |
| Session recovers after sandbox dies | Yes |

This is intentional. Once a sandbox is running, its API key is fixed for the duration of that sandbox lifecycle. A new key is selected the next time a sandbox is created or restored.

## Managing pool members

Each key in a pool can be individually:

- **Enabled/disabled** — disabled keys are skipped during rotation but stay in the pool
- **Removed** — takes the key out of the pool entirely
- **Revoked** — revoking a key in Settings > API Keys automatically excludes it from all pools

If all keys in a pool are revoked or disabled, the system returns a clear error when trying to dispatch.

## Using pools with automations

When creating or editing an automation, the API Key dropdown shows two sections:

- **Key Pools** — shows pool name and number of active keys
- **Individual Keys** — the existing single-key behavior

Selecting a pool means every run of that automation will pick the next available key. Selecting an individual key works exactly as before.

You can switch an automation between a pool and a single key at any time. The system handles the transition cleanly.

## Using pools with sessions

Interactive sessions work the same way. When creating a session, select either a key pool or an individual key. The key is selected when the sandbox is first provisioned.

## A key can belong to multiple pools

The same API key can be added to more than one pool. Each pool tracks its own rotation state independently — using a key through Pool A does not affect the rotation order in Pool B.

## Configuration tips

- **Start simple** — a pool with 2 keys already doubles your effective rate limit capacity
- **Label your keys clearly** — labels like `team-1`, `personal`, `backup` make pool management easier
- **Monitor last-used timestamps** — expand a pool to see when each key was last selected, confirming rotation is working
- **Don't delete referenced pools** — the system prevents deleting a pool that's still used by automations or sessions. Remove the references first.
