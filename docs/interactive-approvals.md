# Interactive classifier overrides

When pi-automode's classifier blocks a tool call with a **non-hard** decision and an interactive Pi UI is available, a user can explicitly override that decision.

The prompt shows the tool name, a shortened preview of its exact input, and the classifier reason. Choose:

- **Deny** — keep the block. Dismissing the prompt also denies.
- **Allow once** — execute this tool call without changing future decisions.
- **Allow this exact action for this session** — allow repeat calls only when the tool name, input, working directory and session identity are identical.

Overrides are held in memory and reset on session start. They are not persistent rules, and an agent cannot grant its own approval. Approved actions are logged as `interactive-approval` when decision logging is enabled.

## Safety boundaries

This feature does **not** override `permissions.deny`, rejected `permissions.ask`, deterministic hard-deny checks, denied paths/search scopes, or classifier results in the `hard_deny` tier. Those continue to block before an override is offered.

Headless use, cancellation and dismissals fail closed. Session approval is exact-match, not wildcard, so approving a `git push` for one branch does not automatically authorize another branch.

**Important:** this extension intercepts Pi tools, but is not a filesystem/network sandbox and does not independently prevent shell commands from reaching credentials.
