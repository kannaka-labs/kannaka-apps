# kannaka-apps

The KannakaHDL app store: declarative applications whose blueprint is a
[kannaka-hdl](https://github.com/flaukowski/kannaka-hdl) growth program,
resolved against live substrate (the running HRM, the crystal registry,
registered composites) and judged by expect gates. The imperative part
stays in one thin host: `runtime/khdl-app.mjs`.

An **app** is a directory under `apps/` with an `app.toml` manifest and
one or more `.khdl` programs. Cloning this repo installs every app; the
store index (`store/index.json`) is the machine-readable storefront.
Design: [ADR-0001](docs/adr/0001-app-model-and-store.md).

## Quickstart

Requires `kannaka-hdl` and `kannaka` on PATH (or `KANNAKA_HDL_BIN` /
`KANNAKA_BIN`), plus Node ≥ 20.11.

```sh
node runtime/khdl-app.mjs list
node runtime/khdl-app.mjs run apps/preflight
node runtime/khdl-app.mjs run apps/provisioner --dry-run
```

## Apps

| app | kind | what it does |
| --- | --- | --- |
| [preflight](apps/preflight/) | gate | Memory integrity gate — the fleet-proven anchor set; run before any one-way HRM operation |
| [provisioner](apps/provisioner/) | provision | Genesis: seed a node's required memory architecture (dark anchors only), then prove it by gate |
| [research-scheduler](apps/research-scheduler/) | schedule | Demand side of the §14 loop: rank unresolved capability demand, record + announce crystal work orders, attribute resolutions ([ADR-0002](docs/adr/0002-research-scheduler.md)) |
| [crystal-worker](apps/crystal-worker/) | work | Supply side: consume the order book with bounded `kannaka-crystal evolve` shifts; fulfil orders when the registry gains a qualifying primitive |
| [mind](apps/mind/) | mind | A citizen grown from the faculties the constellation actually has — served brains, tool calls, presence, studios, the fossil record |

## Through the QuantumOS hub

The store is reachable from any AI through [QuantumOS's hub](https://github.com/kannaka-labs/QuantumOS/tree/main/tools/qos-hub)
(ADR-0027): one policy-gated MCP endpoint for the constellation's CLIs. The hub's example
config carries an `apps` entry whose tools are allowlisted argv templates of this runner:
`apps.list` and `apps.plan` (`run <app> --dry-run`, executes nothing) are allowed; `apps.run`
asks the person first, because a provision, schedule or work app is a one-way operation on
live memory. Nothing in this repository changes for that: the runner's `run`/`list` verbs are
the contract, and `--dry-run` is the read-only half of it.

## Why this shape

- **Resolution is installation**: `--unresolved strict` refuses to bless
  a node whose substrate can't support the app.
- **Emitters are the execution surface**: `memory-plan-v1` lowers a plan
  to executable `kannaka` commands; the runner executes only what is
  missing.
- **Gates are the contract**: an app's exit code is a checked claim
  about live memory, with pinned recall semantics so the verdict never
  depends on who ran it last.

Apps stay in this monorepo until they need their own release cadence or
compiled code, then graduate to their own repo and remain listed in the
index as `external` entries.

## License

[Space Child License v1.0](LICENSE)
