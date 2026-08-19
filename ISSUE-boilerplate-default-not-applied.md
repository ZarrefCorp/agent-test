## Summary

When a consumer workflow invokes `agent-on-card.yml` (or any reusable
workflow in this repo) via `uses: ... @<ref>` and does **not** pass an
input that has a `default:` declared, the input evaluates to an empty
string inside the reusable workflow's steps. The declared `default` is
not honored at runtime.

## Environment

- Boilerplate repo: `LucasBFerraz/agent-boilerplate`
- Affected file: `.github/workflows/agent-on-card.yml`
- Reproduced input: `agent_trigger_label` (default `'agent:ready'`)
- Consumer repo used for repro: `ZarrefCorp/agent-test` (any repo works)

## Reproduction steps

1. In a consumer repo, create `.github/workflows/agent.yml` that invokes
   the reusable workflow **without** explicitly passing `agent_trigger_label`:

   ```yaml
   on:
     issues:
       types: [labeled]
   jobs:
     on-card:
       uses: LucasBFerraz/agent-boilerplate/.github/workflows/agent-on-card.yml@master
       with:
         agent: mavis
         project_title: 'Engineering Backlog'
         # agent_trigger_label intentionally omitted — should fall back to the default
       secrets:
         agent_gh_token: ${{ secrets.AGENT_GH_TOKEN }}
   ```

2. Open an issue, apply a label named exactly `agent:ready` (matching the
   documented default).

3. Observe the `Decide trigger and issue` step log:

   ```
   LABEL_NAME: agent:ready
   TRIGGER_LABEL:               <-- empty, should be 'agent:ready'
   ```

4. Step exits with `0` and the message
   `Label agent:ready does not match ; skipping.` — the run aborts
   silently from the consumer's perspective.

## Expected behavior

`${{ inputs.agent_trigger_label }}` resolves to `'agent:ready'` (the
declared `default`), so the filter at
`.github/workflows/agent-on-card.yml:138` passes and the run continues
to `kanban-read-card`.

## Actual behavior

`${{ inputs.agent_trigger_label }}` resolves to the empty string. The
filter rejects every label (including the one that matches the
intended default), and the run ends with `exit 0` and no PR.

## Workaround

Pass every input explicitly from the consumer workflow, even when its
value matches the documented default. Example:

```yaml
with:
  agent: mavis
  project_title: 'Engineering Backlog'
  agent_trigger_label: 'agent:ready'   # must be passed explicitly
  base_ref: 'main'
  # ...
```

## Suggested fix (in this repo)

Pick one:

- **(a) Document the gotcha** in `docs/setup.md` and
  `docs/extending-agents.md` so consumer authors always pass inputs
  explicitly.
- **(b) Add a guard inside `agent-on-card.yml`** that falls back to a
  hardcoded value if the input is empty, e.g.:

  ```bash
  TRIGGER_LABEL="${TRIGGER_LABEL:-agent:ready}"
  ```

  This is defensive and survives the (apparent) GitHub Actions quirk
  regardless of root cause.
- **(c) Investigate root cause** — confirm whether this is a known
  GitHub Actions behavior for `workflow_call` inputs with defaults
  consumed via `${{ inputs.x }}` in `env:` blocks, and report upstream
  if reproducible.

## Acceptance criteria

- [ ] Decision made between (a), (b), (c)
- [ ] If (a): docs updated, examples updated
- [ ] If (b): guard added in `agent-on-card.yml` (and ideally the
  other reusable workflows in this repo), test added
- [ ] If (c): finding documented, action item created

## Out of scope

- Changing the input contract (names, types, defaults)
- Removing other input defaults "to be safe"
