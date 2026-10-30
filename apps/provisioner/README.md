# provisioner

The genesis app: a node runs it to acquire (and prove) the memory
architecture its role requires. Flow, bounded to one seed round:

1. Gate (strict). Passes → already provisioned, exit 0.
2. Seed program grows speculatively; anchors the live HRM cannot
   resolve lower to `kannaka remember` commands (memory-plan-v1).
3. The runner executes commands for **dark anchors only**, through the
   node's own `kannaka` CLI.
4. Gate again — that verdict is the app's exit code.

```sh
node runtime/khdl-app.mjs run apps/provisioner            # provision
node runtime/khdl-app.mjs run apps/provisioner --dry-run  # show seeds only
```

Anchor text doubles as seed content, so each anchor is a
self-contained factual statement — the plan is the documentation is
the memory.

**Known substrate limit — genesis on a near-empty HRM:** kannaka-memory
similarity scores currently depend on `--top-k` when the HRM holds only a
handful of memories (measured 2026-08-06: 5-memory HRM, exact-text match
scores 0.99999 at k=3 but 0.033 at k≥4; the memory provider recalls at
top-k 8). Until
[kannaka-memory#716](https://github.com/kannaka-labs/kannaka-memory/issues/716)
is fixed, a freshly-seeded near-empty node can fail its re-gate even though
the seeds landed — the one-round bound reports this honestly instead of
looping. Nodes with fleet-scale HRMs (hundreds of memories) are unaffected
(k=3 and k=8 return identical scores there).

**Single-writer nodes (O2 witness): do not run this.** Its HRM is
written only by the witness service; `seed_via = "cli"` is the only
implemented path and the runner refuses anything else. The witness
repair needs a seed executor that speaks the witness service's write
API (ADR-0001 §5) — infrastructure is otherwise ready for it.
