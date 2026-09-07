#!/usr/bin/env node
// khdl-app — minimal host runtime for KannakaHDL apps (ADR-0001).
//
//   node khdl-app.mjs run <app-dir> [--variant NAME] [--dry-run]
//   node khdl-app.mjs list [store-root]
//
// Environment:
//   KANNAKA_HDL_BIN   kannaka-hdl binary (default: kannaka-hdl on PATH)
//   KANNAKA_BIN       kannaka binary     (default: kannaka on PATH)
//   KHDL_APP_LOG      append log         (default: ~/.kannaka/khdl-app.log)
//
// Exit codes: 0 = app succeeded (gate passed / provisioned and re-gated);
// nonzero = the verdict, propagated from kannaka-hdl where applicable.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const HDL = process.env.KANNAKA_HDL_BIN || "kannaka-hdl";
const KAN = process.env.KANNAKA_BIN || "kannaka";
const LOG =
  process.env.KHDL_APP_LOG || join(homedir(), ".kannaka", "khdl-app.log");

// Pin recall semantics: experimental ranking knobs left exported in a shell
// change what the live memory returns (measured 2026-08-06). A gate that
// inherits experiment flags is a gate whose verdict depends on who ran it
// last; apps always judge default recall.
const PINNED_ENV = { ...process.env };
for (const k of Object.keys(PINNED_ENV)) {
  if (k.startsWith("KANNAKA_RECALL_") || k === "KANNAKA_GLYPH_GRAVITY") {
    delete PINNED_ENV[k];
  }
}

function log(line) {
  const stamp = new Date().toISOString();
  try {
    mkdirSync(join(homedir(), ".kannaka"), { recursive: true });
    appendFileSync(LOG, `[${stamp}] ${line}\n`);
  } catch {
    // Logging must never change a verdict.
  }
}

function die(msg, code = 2) {
  console.error(`khdl-app: ${msg}`);
  process.exit(code);
}

// --- app.toml (deliberate subset: [sections] + flat key = value) ----------

function parseToml(text) {
  const doc = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (sec) {
      section = sec[1];
      doc[section] = doc[section] || {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`app.toml: cannot parse line: ${raw}`);
    if (!section) throw new Error(`app.toml: key before any [section]: ${raw}`);
    let value = kv[2].trim();
    const str = value.match(/^"(.*)"$/);
    if (str) value = str[1];
    else if (value === "true" || value === "false") value = value === "true";
    else if (!Number.isNaN(Number(value))) value = Number(value);
    else throw new Error(`app.toml: unquoted string value: ${raw}`);
    doc[section][kv[1]] = value;
  }
  return doc;
}

function loadManifest(appDir) {
  const path = join(appDir, "app.toml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(`${path}: ${e.message}`);
  }
  const doc = parseToml(text);
  if (!doc.app?.name || !doc.run?.mode) {
    die(`${path}: [app] name and [run] mode are required`);
  }
  return doc;
}

// --- subprocess plumbing ---------------------------------------------------

function runCapture(bin, args) {
  const r = spawnSync(bin, args, { env: PINNED_ENV, encoding: "utf8" });
  if (r.error) die(`cannot run ${bin}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function scratchFile(name) {
  const dir = join(tmpdir(), "khdl-app");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${process.pid}-${name}`);
}

// --- modes -----------------------------------------------------------------

function runGate(appDir, gateRel, label) {
  const gate = join(appDir, gateRel);
  const out = scratchFile("gate-plan.json");
  const r = runCapture(HDL, [
    "grow", gate,
    "--memory-provider", KAN,
    "--unresolved", "strict",
    "--emit", "json",
    "--out", out,
  ]);
  rmSync(out, { force: true });
  const summary = r.stderr
    .split(/\r?\n/)
    .filter((l) => /resolved|warning|expect|error|strict/.test(l))
    .join("\n  ");
  log(`${label} gate=${gateRel} exit=${r.code}\n  ${summary}`);
  process.stderr.write(r.stderr);
  return r.code;
}

// memory-plan-v1 lowered command shapes (kannaka-hdl src/emit.rs):
//   kannaka remember "<text> (node mN, plan HASH)" --importance F.FF
//   kannaka dream --mode deep   # node mN
function seedCommands(plan, importanceOverride) {
  const dark = new Set(
    (plan.nodes || []).filter((n) => n.resolved == null).map((n) => n.id)
  );
  const seeds = [];
  for (const cmd of plan.commands || []) {
    const rem = cmd.match(/^kannaka remember "(.+)" --importance ([0-9.]+)$/);
    if (rem) {
      const node = [...dark].find((id) => rem[1].includes(`(node ${id},`));
      if (!node) continue; // resolved anchors are never re-seeded
      const importance = importanceOverride ?? Number(rem[2]);
      seeds.push({ node, args: ["remember", rem[1], "--importance", importance.toFixed(2)] });
      continue;
    }
    const dream = cmd.match(/^kannaka dream --mode (\w+)\s+# node (m\d+)$/);
    if (dream && dark.has(dream[2])) {
      seeds.push({ node: dream[2], args: ["dream", "--mode", dream[1]] });
    }
  }
  return seeds;
}

function runProvision(appDir, manifest, variant, dryRun) {
  const run = { ...manifest.run };
  if (variant) {
    const alt = manifest.variants?.[variant];
    if (!alt) die(`variant "${variant}" not in [variants]`);
    run.seed = alt;
  }
  if (!run.seed || !run.gate) die(`provision mode requires [run] seed and gate`);
  const seedVia = run.seed_via ?? "cli";
  if (seedVia !== "cli") {
    die(
      `seed_via = "${seedVia}" is not implemented. Only "cli" exists; on ` +
        `single-writer nodes (witness) seeding must go through the owning ` +
        `service's write path — refusing to guess (ADR-0001 §5).`
    );
  }

  const name = manifest.app.name;
  if (runGate(appDir, run.gate, `${name} pre`) === 0) {
    console.error(`${name}: gate already passes — nothing to provision`);
    return 0;
  }

  const planFile = scratchFile("seed-plan.json");
  const grow = runCapture(HDL, [
    "grow", join(appDir, run.seed),
    "--memory-provider", KAN,
    "--unresolved", "speculative",
    "--emit", "memory",
    "--out", planFile,
  ]);
  process.stderr.write(grow.stderr);
  if (grow.code !== 0) {
    log(`${name} seed-grow FAILED exit=${grow.code}`);
    die(`seed program failed to grow (exit ${grow.code})`, grow.code);
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  rmSync(planFile, { force: true });

  const seeds = seedCommands(plan, run.seed_importance);
  if (seeds.length === 0) {
    log(`${name} gate fails but seed plan has no dark anchors — floors disagree?`);
    console.error(
      `${name}: gate fails yet nothing to seed. Gate and seed programs ` +
        `disagree about what "dark" means — fix the app, not the memory.`
    );
    return 1;
  }

  console.error(`${name}: seeding ${seeds.length} dark anchor(s) via ${KAN}`);
  for (const s of seeds) {
    console.error(`  ${s.node}: kannaka ${s.args.join(" ")}`);
    if (dryRun) continue;
    const r = runCapture(KAN, s.args);
    log(`${name} seed ${s.node} exit=${r.code} args=${JSON.stringify(s.args)}`);
    if (r.code !== 0) {
      process.stderr.write(r.stderr);
      die(`seed command failed on ${s.node} (exit ${r.code})`, r.code);
    }
  }
  if (dryRun) {
    console.error(`${name}: dry run — no seeds executed, gate not re-run`);
    return 0;
  }

  const verdict = runGate(appDir, run.gate, `${name} post`);
  console.error(
    verdict === 0
      ? `${name}: provisioned — gate now passes`
      : `${name}: seeded but gate STILL fails (exit ${verdict}) — one round is the bound, investigate before re-running`
  );
  return verdict;
}

// --- schedule mode (ADR-0002: research scheduler) -------------------------
//
// Closes the kannaka-hdl §14 loop: sweep the store's programs for unresolved
// queries (capability demand), rank by how many programs each blocks, emit
// crystal work orders onto the swarm queue, and attribute resolved flips to
// the order that requested them. The scheduler only ENQUEUES — crystal work
// executes in the crystal lane, never here.

function statePath() {
  return process.env.KHDL_SCHEDULER_STATE ||
    join(homedir(), ".kannaka", "research-scheduler.json");
}

// Swarm enqueue needs NATS credentials; crons source ~/.kannaka-nats.env for
// the same reason (anonymous NATS publishes are silently dropped). Merge that
// file into the child env when the shell doesn't already carry creds.
function natsEnv() {
  if (PINNED_ENV.NATS_USER) return PINNED_ENV;
  try {
    const env = { ...PINNED_ENV };
    for (const line of readFileSync(join(homedir(), ".kannaka-nats.env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return env;
  } catch {
    return PINNED_ENV;
  }
}

// `kannaka swarm enqueue` is request-reply: it publishes the task, then waits
// for a WORKER to answer. No crystal-work worker exists yet, so a reply
// timeout after a successful publish still means the order is on the queue.
function enqueueOrder(order) {
  const r = spawnSync(
    KAN,
    ["swarm", "enqueue", "crystal_work_order", JSON.stringify(order), "--timeout", "5"],
    { env: natsEnv(), encoding: "utf8" }
  );
  if (r.error) return { posted: false, why: r.error.message };
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status === 0) return { posted: true, why: "worker replied" };
  if (out.includes("[enqueue] KANNAKA.work.")) {
    return { posted: true, why: "published; no worker reply yet" };
  }
  return { posted: false, why: `exit ${r.status}: ${out.trim().split("\n").pop()}` };
}

function sweepPrograms(storeRoot, appDir, manifest) {
  const programs = [];
  const appsDir = join(storeRoot, "apps");
  for (const name of readdirSync(appsDir)) {
    let m;
    try {
      m = parseToml(readFileSync(join(appsDir, name, "app.toml"), "utf8"));
    } catch {
      continue;
    }
    for (const key of ["entry", "gate", "seed"]) {
      if (m.run?.[key]) {
        programs.push({ app: name, file: join(appsDir, name, m.run[key]) });
      }
    }
    for (const rel of Object.values(m.variants || {})) {
      programs.push({ app: name, file: join(appsDir, name, rel) });
    }
  }
  const demandRel = manifest.run.demand_dir || "demand";
  const demandDir = join(appDir, demandRel);
  try {
    for (const f of readdirSync(demandDir)) {
      if (f.endsWith(".khdl")) {
        programs.push({ app: `${manifest.app.name}/${demandRel}`, file: join(demandDir, f) });
      }
    }
  } catch {
    // no demand dir — sweep is just the store apps
  }
  // A program may be referenced twice (e.g. preflight default = a variant);
  // dedupe by absolute path.
  const seen = new Set();
  return programs.filter((p) => !seen.has(p.file) && seen.add(p.file));
}

function harvestDemand(program) {
  const out = scratchFile(`sweep-${program.app.replace(/[\\/]/g, "_")}.json`);
  const r = runCapture(HDL, [
    "grow", program.file,
    "--memory-provider", KAN,
    "--unresolved", "speculative",
    "--emit", "json",
    "--out", out,
  ]);
  const requests = [];
  if (r.code === 0) {
    try {
      const plan = JSON.parse(readFileSync(out, "utf8"));
      for (const req of plan.discovery_requests || []) {
        requests.push({
          domain: req.domain,
          class: req.class,
          component_type: req.component_type,
          constraints: req.constraints,
          plan_hash: plan.plan_hash,
        });
      }
    } catch (e) {
      log(`schedule: unparseable plan for ${program.file}: ${e.message}`);
    }
  } else {
    // Expect-gated programs refuse to emit while failing ("nothing emitted"),
    // but their unresolved anchors ARE demand — harvest from the warnings.
    const warn = /warning: (\w+): no component \(class "(.+?)", min_persistence ([0-9.eE+-]+), min_noise_tolerance ([0-9.eE+-]+)/g;
    for (const m of r.stderr.matchAll(warn)) {
      requests.push({
        domain: "unknown",
        class: m[2],
        component_type: null,
        constraints: { min_persistence: Number(m[3]), min_noise_tolerance: Number(m[4]), material: null },
        plan_hash: null,
        degraded: true,
      });
    }
  }
  rmSync(out, { force: true });
  return { grewClean: r.code === 0, requests };
}

function runSchedule(appDir, manifest, dryRun) {
  const storeRoot = resolve(join(appDir, "..", ".."));
  const maxOrders = manifest.run.max_orders ?? 3;
  const programs = sweepPrograms(storeRoot, appDir, manifest);
  console.error(`research-scheduler: sweeping ${programs.length} program(s)`);

  // 1-2. Collect demand across every program.
  const backlog = new Map(); // key = domain|class
  const cleanPrograms = new Set();
  for (const p of programs) {
    const { grewClean, requests } = harvestDemand(p);
    if (grewClean) cleanPrograms.add(p.app + ":" + p.file);
    for (const req of requests) {
      // Evidence/capability floors change the KIND of supply work
      // (promotion, not evolve), so they are part of demand identity —
      // a validated-capability ask must never merge with a raw metric
      // frontier for the same class. Scalar floors still merge by max.
      const key = `${req.domain}|${req.class}` +
        `|e${req.constraints.min_evidence || 0}|c${req.constraints.capability || ""}`;
      const entry = backlog.get(key) || {
        key, domain: req.domain, class: req.class,
        component_type: req.component_type,
        constraints: { min_persistence: 0, min_noise_tolerance: 0, material: null },
        requesters: [],
      };
      entry.requesters.push({ app: p.app, file: p.file, plan_hash: req.plan_hash });
      entry.constraints.min_persistence = Math.max(entry.constraints.min_persistence, req.constraints.min_persistence || 0);
      entry.constraints.min_noise_tolerance = Math.max(entry.constraints.min_noise_tolerance, req.constraints.min_noise_tolerance || 0);
      entry.constraints.min_evidence = req.constraints.min_evidence || 0;
      entry.constraints.capability = req.constraints.capability || null;
      entry.constraints.material = entry.constraints.material || req.constraints.material;
      backlog.set(key, entry);
    }
  }

  // 3. Rank: blocked-plan count first, floor stringency as tiebreak.
  const ranked = [...backlog.values()].sort((a, b) =>
    b.requesters.length - a.requesters.length ||
    (b.constraints.min_persistence + b.constraints.min_noise_tolerance) -
    (a.constraints.min_persistence + a.constraints.min_noise_tolerance)
  );

  // 4. State: attribution across runs.
  let state = { requests: {}, orders: [] };
  try {
    state = JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    // first run
  }
  // Migrate pre-v0.9 request keys (domain|class) to the constraint-aware
  // format — both legacy orders were plain-floor demand, i.e. |e0|c.
  for (const key of Object.keys(state.requests)) {
    if (!key.includes("|e")) {
      state.requests[`${key}|e0|c`] = state.requests[key];
      delete state.requests[key];
    }
  }
  const now = new Date().toISOString();

  // 5. Flips: previously-demanded, now absent from the backlog → resolved.
  for (const [key, rec] of Object.entries(state.requests)) {
    if (!backlog.has(key) && !rec.resolved_at) {
      rec.resolved_at = now;
      const via = rec.order_id ? ` (attributed to order ${rec.order_id})` : " (no order issued)";
      console.error(`research-scheduler: RESOLVED ${key}${via}`);
      log(`schedule RESOLVED ${key}${via}`);
    }
  }
  for (const entry of ranked) {
    const rec = state.requests[entry.key] || { first_seen: now };
    rec.last_seen = now;
    rec.blocked_plans = entry.requesters.length;
    delete rec.resolved_at; // demand is back (or still) live
    state.requests[entry.key] = rec;
  }

  // 6. Orders for the top of the backlog. Memory-domain demand is recall
  // supply (provisioner territory), not crystal-growable — skip it here.
  const orderable = ranked.filter((e) => e.domain !== "memory");
  let issued = 0;
  for (const entry of orderable.slice(0, maxOrders)) {
    const rec = state.requests[entry.key];
    if (rec.order_id) {
      // Ratchet support: a demand key can come BACK after its order was
      // fulfilled (the floor rose past the supplied primitive — the
      // living-demand pattern). A fulfilled order must not block reissue;
      // archive the linkage and fall through to a fresh order. An OPEN
      // order still means one-standing-order-per-request.
      const existing = (state.orders || []).find((o) => o.order_id === rec.order_id);
      if (existing && !existing.fulfilled_at) continue;
      (rec.previous_orders = rec.previous_orders || []).push(rec.order_id);
      delete rec.order_id;
    }
    const orderId = `rs-${Date.now().toString(36)}-${issued}`;
    const order = {
      order_type: "crystal_work_order",
      order_id: orderId,
      domain: entry.domain,
      class: entry.class,
      component_type: entry.component_type,
      constraints: entry.constraints,
      blocked_plans: entry.requesters.length,
      attributions: entry.requesters.map((r) => `${r.app}:${r.plan_hash ?? "unsealed"}`),
      suggested_procedure:
        "kannaka-crystal evolve toward this class, then promote --procedure replicate; " +
        "behavior contracts (promote --procedure behavior) once L2",
      issued_at: now,
      issued_by: "kannaka-apps/research-scheduler",
    };
    console.error(`research-scheduler: order ${orderId} → ${entry.domain}.${entry.class} (blocks ${entry.requesters.length} plan(s))`);
    if (!dryRun) {
      const { posted, why } = enqueueOrder(order);
      order.enqueued = posted;
      order.enqueue_note = why;
      if (!posted) {
        console.error(`  enqueue failed (${why}) — order recorded locally only`);
        log(`schedule enqueue FAILED ${orderId}: ${why}`);
      } else {
        console.error(`  enqueued (${why})`);
      }
    } else {
      order.enqueued = false;
      order.dry_run = true;
    }
    rec.order_id = orderId;
    state.orders.push(order);
    issued++;
  }

  // 7. Report + persist.
  console.error(
    `research-scheduler: backlog ${ranked.length} (memory-domain ${ranked.length - orderable.length}), ` +
    `orders issued ${issued}, programs clean ${cleanPrograms.size}/${programs.length}`
  );
  for (const e of ranked) {
    console.error(`  ${String(e.requesters.length).padStart(2)}x ${e.domain}.${e.class}`);
  }
  if (!dryRun) {
    mkdirSync(join(homedir(), ".kannaka"), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
  }
  return 0;
}

// --- work mode (crystal-worker: the supply side of ADR-0002) ---------------
//
// Consumes the scheduler's order book. One run = one bounded "shift" of
// kannaka-crystal evolve attempts per open order. Only RUNS the crystal CLI —
// never edits crystal source; registration happens through evolve's own path.

const WORKER_MATERIALS = [
  "ideal_resonator", "metamaterial", "europium_crystal",
  "diamond_nv", "optical_cavity", "silicon",
  // Wall-probe additions (2026-08-07): the only two built-in materials the
  // grid had never tried — vacuum (zero damping, no reflection) and
  // graphene_model (fastest c, weak reflection).
  "vacuum", "graphene_model",
];

// hdl-compatible class match: "Memory Seed" ≡ "MemorySeed".
function normClass(c) {
  return String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function crystalRegistryPath() {
  const dir = process.env.KANNAKA_CRYSTAL_DATA_DIR ||
    join(homedir(), ".kannaka-crystal");
  return join(dir, "registry.json");
}

function qualifyingRows(order) {
  let rows;
  try {
    const j = JSON.parse(readFileSync(crystalRegistryPath(), "utf8"));
    rows = j.primitives || j;
  } catch {
    return [];
  }
  const want = normClass(order.class);
  const c = order.constraints || {};
  return rows.filter((p) =>
    normClass(p.class) === want &&
    (p.persistence || 0) >= (c.min_persistence || 0) &&
    (p.noise_tolerance || 0) >= (c.min_noise_tolerance || 0) &&
    // hdl v0.9 floors: absent evidence_level = 1 Observed (crystal
    // v0.10); capability satisfied by PASSED records only (v0.11).
    (p.evidence_level ?? 1) >= (c.min_evidence || 0) &&
    (!c.capability ||
      (p.behavioral_capabilities || []).some((r) => r.passed && r.name === c.capability))
  );
}

function runWork(appDir, manifest, dryRun) {
  const crystal = process.env.KANNAKA_CRYSTAL_BIN || "kannaka-crystal";
  const attempts = process.env.KHDL_WORK_ATTEMPTS != null
    ? Number(process.env.KHDL_WORK_ATTEMPTS)
    : manifest.run.attempts ?? 8;
  // Deep-budget shifts: the 30-generation manual run outscored every
  // 10-generation attempt (fitness 1.881 vs 1.66), so persistence-frontier
  // orders sometimes warrant fewer, deeper attempts.
  const generations = process.env.KHDL_WORK_GENERATIONS != null
    ? Number(process.env.KHDL_WORK_GENERATIONS)
    : manifest.run.generations ?? 10;
  // Population is the OTHER budget axis (generations scaling saturated at
  // the ~0.91 persistence wall with pop fixed at 12) — override for probes.
  const population = process.env.KHDL_WORK_POPULATION != null
    ? Number(process.env.KHDL_WORK_POPULATION)
    : manifest.run.population ?? 12;

  let state;
  try {
    state = JSON.parse(readFileSync(statePath(), "utf8"));
  } catch (e) {
    die(`no order book at ${statePath()} — run research-scheduler first (${e.message})`);
  }
  const open = (state.orders || []).filter(
    (o) => !o.fulfilled_at && o.order_type === "crystal_work_order"
  );
  if (open.length === 0) {
    console.error("crystal-worker: no open orders — nothing to do");
    return 0;
  }
  console.error(`crystal-worker: ${open.length} open order(s), shift budget ${attempts} attempt(s) each`);

  // Evolve registers into ONE shared registry, so attempts are global —
  // running the same strategy once per order would be pure waste. Each
  // evolve runs once; every open order is checked against the registry
  // after it. state.shift_attempts persists across shifts so a strategy
  // (material × robust × seed) is never repeated.
  const stillOpen = () => open.filter((o) => !o.fulfilled_at);
  const stamp = (order, row, note) => {
    order.fulfilled_at = new Date().toISOString();
    order.fulfilled_by = row.id;
    if (note) order.fulfilled_note = note;
    console.error(
      `  ${order.order_id}: FULFILLED by ${row.id} (persistence ${(row.persistence || 0).toFixed(3)}, ` +
      `noise_tol ${(row.noise_tolerance || 0).toFixed(3)})${note ? ` — ${note}` : ""}`
    );
    log(`work ${order.order_id} FULFILLED by ${row.id}`);
  };

  // Out-of-band supply (another node's evolve, a manual run) may already
  // satisfy an order — check before spending compute.
  for (const order of open) {
    const rows = qualifyingRows(order);
    if (rows.length > 0) stamp(order, rows[0], "satisfied before shift (out-of-band supply)");
  }

  // Capability orders (hdl v0.9) are PROMOTION work, not evolve work: the
  // class already exists — what's missing is validation. Supply path per
  // crystal ADR-0004: promote --procedure replicate (L2; a failed
  // replicate honestly DEMOTES the row), then promote --procedure
  // behavior --capability <name>. Candidates are the strongest same-class
  // rows; only post-v0.8 rows carry the experiment manifest promotion
  // needs, so failures on old rows are expected and cheap.
  for (const order of stillOpen().filter((o) => o.constraints?.capability)) {
    const cap = order.constraints.capability;
    let rows = [];
    try {
      const j = JSON.parse(readFileSync(crystalRegistryPath(), "utf8"));
      rows = (j.primitives || j)
        .filter((p) => normClass(p.class) === normClass(order.class))
        // Promotion replays the genome from the experiment manifest;
        // pre-ADR-0004 rows have none and crystal refuses them outright
        // ("regenerate it through a manifested run") — measured: the
        // all-time record holders are all unpromotable for this reason.
        .filter((p) => p.experiment_id)
        .sort((a, b) => (b.persistence || 0) - (a.persistence || 0))
        .slice(0, manifest.run.promotion_candidates ?? 4);
    } catch {
      // registry unreadable — fall through to the evolve shift
    }
    order.promotion_log = order.promotion_log || [];
    for (const row of rows) {
      console.error(`  ${order.order_id}: promotion candidate ${row.id} (persistence ${(row.persistence || 0).toFixed(3)}, L${row.evidence_level ?? 1})`);
      if (dryRun) continue;
      const steps = [];
      if ((row.evidence_level ?? 1) < 2) {
        steps.push(["promote", row.id, "--procedure", "replicate"]);
      }
      steps.push(["promote", row.id, "--procedure", "behavior", "--capability", cap]);
      let failed = false;
      for (const args of steps) {
        const r = runCapture(crystal, args);
        const line = (r.stdout + r.stderr).trim().split("\n").pop();
        order.promotion_log.push({ id: row.id, args: args.join(" "), exit: r.code, note: line, at: new Date().toISOString() });
        console.error(`    ${args[3]}${args[5] ? " " + args[5] : ""}: exit ${r.code} — ${line}`);
        if (r.code !== 0) { failed = true; break; }
      }
      if (failed) continue;
      const hits = qualifyingRows(order);
      if (hits.length > 0) {
        stamp(order, hits.find((h) => h.id === row.id) || hits[0], "promotion shift");
        break;
      }
    }
  }

  // Data-driven material bias: the registry's own record-holders say which
  // material produces the metric an order is starved for. For each open
  // order, find the material of the best same-class rows; odd attempts use
  // that material, even attempts keep the exploration rotation. (Measured
  // 2026-08-07: the top five Standing Echo persistence rows are ALL
  // metamaterial, but a flat rotation gives it 1-2 attempts in 8.)
  const biasFor = (order) => {
    let rows;
    try {
      const j = JSON.parse(readFileSync(crystalRegistryPath(), "utf8"));
      rows = (j.primitives || j).filter((p) => normClass(p.class) === normClass(order.class));
    } catch {
      return null;
    }
    if (rows.length === 0) return null;
    const metric = (order.constraints?.min_persistence || 0) >= (order.constraints?.min_noise_tolerance || 0)
      ? "persistence" : "noise_tolerance";
    const byMat = {};
    for (const p of rows.sort((a, b) => (b[metric] || 0) - (a[metric] || 0)).slice(0, 10)) {
      const m = p.material || p.material_id;
      if (m) byMat[m] = (byMat[m] || 0) + 1;
    }
    const top = Object.entries(byMat).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  };
  const biases = [...new Set(stillOpen().map(biasFor).filter(Boolean))];
  if (biases.length) console.error(`  registry bias: record-holders favour ${biases.join(", ")}`);

  // Evolve only helps demand that raw discovery can satisfy: fresh rows
  // register at L1 with no capability records, so orders floored on
  // evidence ≥ 2 or a capability are promotion work (above), never
  // evolve work.
  const evolvable = () => stillOpen().filter(
    (o) => !o.constraints?.capability && (o.constraints?.min_evidence || 0) <= 1
  );
  state.shift_attempts = state.shift_attempts || 0;
  state.shift_log = state.shift_log || [];
  for (let i = 0; i < attempts && evolvable().length > 0; i++) {
    const n = state.shift_attempts;
    const rotation = WORKER_MATERIALS[n % WORKER_MATERIALS.length];
    const material = (n % 2 === 1 && biases.length)
      ? biases[Math.floor(n / 2) % biases.length]
      : rotation;
    const robust = n % 2 === 0;
    const seed = 1000 + n;
    const args = [
      "evolve", "--material", material,
      "--generations", String(generations),
      "--population", String(population),
      "--seed", String(seed),
      ...(robust ? ["--robust"] : []),
    ];
    console.error(
      `  attempt ${n + 1}: ${material} seed=${seed}${robust ? " robust" : ""} ` +
      `(${evolvable().length} evolvable order(s) open)`
    );
    if (dryRun) { state.shift_attempts++; continue; }

    const r = runCapture(crystal, args);
    const discovered = (r.stdout + r.stderr).match(/(\d+) new primitives/);
    state.shift_attempts++;
    state.shift_log.push({
      n: state.shift_attempts, material, seed, robust,
      exit: r.code,
      new_primitives: discovered ? Number(discovered[1]) : null,
      at: new Date().toISOString(),
    });
    if (r.code !== 0) {
      console.error(`    evolve failed (exit ${r.code}) — continuing shift`);
      log(`work shift attempt ${state.shift_attempts} evolve exit=${r.code}`);
      continue;
    }
    for (const order of stillOpen()) {
      const hits = qualifyingRows(order);
      if (hits.length > 0) {
        stamp(order, hits.sort((a, b) => (b.persistence || 0) - (a.persistence || 0))[0]);
      }
    }
  }
  for (const order of stillOpen()) {
    console.error(`  ${order.order_id}: still open (shift attempts to date: ${state.shift_attempts}) — order stands`);
  }
  // dry-run mutates state in memory only — nothing below persists it.

  if (!dryRun) {
    writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
  }
  const fulfilled = open.filter((o) => o.fulfilled_at).length;
  console.error(`crystal-worker: shift complete — ${fulfilled}/${open.length} order(s) fulfilled`);
  return 0;
}

// --- mind: a citizen grown from the faculties the substrate has ------------
//
// 1. bin/mind-registry.py probes the live substrate for ONE instance and writes a
//    registry in the crystal schema (served brains + judge scores, tool-call probe,
//    presence, studios, fossil record, standing).
// 2. kannaka-hdl grows the Mind program against it (domain `mind`, v0.10).
// 3. Every leaf is printed with what it resolved to; unresolved leaves are demand and
//    are routed by faculty. Exit 0 = the mind is whole; 1 = it is not (strict grow).
const MIND_ROUTES = {
  Voice: "the weekly trainer (rogue-agent weekly.py): more of her words, DPO pairs from the judge",
  Hands: "the brain's chat template / a tool-call probe on the served tag",
  Presence: "the citizen loop (rogue-agent@<name>): cadence, skills, DMs, walks",
  Image: "studio access (Pixel Atelier) — the daily routine's image step",
  Song: "sunoapi credits (floor 12) — the daily routine's song step",
  Spoken: "ElevenLabs quota (floor 2000 chars) — the daily routine's spoken step",
  Verdict: "the grid relay authoring as this family, and time for the fossil record",
  Standing: "the citizen routine (quests, endorsements, collabs) — reputation",
};

function runMind(appDir, manifest, opts) {
  const instance = opts.instance;
  if (!instance) die(`mind mode requires --instance <name> (rogue, ghost-signal, ...)`);
  const root = manifest.run.root || "/srv/rogue";
  const instDir = instance === "rogue" ? root : join(root, "instances", instance);
  if (!existsSync(instDir)) die(`no instance at ${instDir}`);
  const registry = join(instDir, "mind-registry.json");
  const builder = join(appDir, manifest.run.registry_builder || "bin/mind-registry.py");
  const bargs = [builder, "--instance", instance, "--out", registry];
  if (opts.noProbe) bargs.push("--no-tool-probe");
  const b = spawnSync("python3", bargs, { encoding: "utf8", env: { ...process.env, ROGUE_ROOT: root } });
  if (b.status !== 0) die(`mind registry build failed (exit ${b.status})
${b.stderr}`);
  process.stderr.write(b.stdout);
  const program = join(appDir, manifest.run.program || "mind.khdl");
  const out = scratchFile("mind-plan.json");
  const args = ["grow", program, "--mind-registry", registry, "--unresolved", opts.speculative ? "speculative" : "strict",
    "--emit", "json", "--out", out];
  const r = runCapture(HDL, args);
  let plan = null;
  try { plan = JSON.parse(readFileSync(out, "utf8")); } catch { /* strict failure emits nothing */ }
  rmSync(out, { force: true });
  const leaves = plan?.leaves || plan?.nodes || [];
  const demand = [];
  console.log(`mind ${instance} — ${leaves.length} faculties${plan ? "" : " (strict grow refused; re-run with --speculative to see the plan)"}`);
  for (const l of leaves) {
    const cls = l.query?.class || l.class || l.cell;
    const res = l.resolved;
    if (res) {
      console.log(`  ok    ${String(cls).padEnd(9)} <- ${res.id}  persistence=${Number(res.persistence).toFixed(2)} evidence=${res.evidence_level ?? "?"} [${(res.capabilities || []).join(",")}]`);
    } else {
      demand.push(cls);
      console.log(`  NEED  ${String(cls).padEnd(9)} -> ${MIND_ROUTES[cls] || "no route yet"}`);
    }
  }
  const warnings = (plan?.warnings || []).filter((w) => !/^registry unavailable/.test(w));
  if (!plan) {
    const summary = r.stderr.split(/\r?\n/).filter((l) => /warning|unresolved|strict|error/.test(l)).join("\n  ");
    console.log(`  ${summary}`);
  }
  if (demand.length === 0 && r.code === 0) {
    console.log(`mind ${instance}: whole`);
    return 0;
  }
  console.log(`mind ${instance}: ${demand.length || "some"} faculty(ies) unresolved — demand: ${demand.join(", ") || "(see warnings)"}`);
  return 1;
}

function runApp(appDir, opts) {
  const manifest = loadManifest(appDir);
  const mode = manifest.run.mode;
  if (mode === "mind") {
    return runMind(appDir, manifest, opts);
  }
  if (mode === "gate") {
    let entry = manifest.run.entry;
    if (opts.variant) {
      entry = manifest.variants?.[opts.variant];
      if (!entry) die(`variant "${opts.variant}" not in [variants]`);
    }
    if (!entry) die(`gate mode requires [run] entry`);
    return runGate(appDir, entry, manifest.app.name);
  }
  if (mode === "provision") {
    return runProvision(appDir, manifest, opts.variant, opts.dryRun);
  }
  if (mode === "schedule") {
    return runSchedule(appDir, manifest, opts.dryRun);
  }
  if (mode === "work") {
    return runWork(appDir, manifest, opts.dryRun);
  }
  die(`unknown [run] mode "${mode}" (gate | provision | schedule | work | mind)`);
}

function listStore(root) {
  let index;
  try {
    index = JSON.parse(readFileSync(join(root, "store", "index.json"), "utf8"));
  } catch (e) {
    die(`store index unreadable: ${e.message}`);
  }
  for (const app of index.apps) {
    console.log(
      `${app.name.padEnd(20)} ${String(app.version).padEnd(8)} ${app.kind.padEnd(10)} ${app.description}`
    );
  }
  return 0;
}

// --- entry -----------------------------------------------------------------

const argv = process.argv.slice(2);
const cmd = argv.shift();
if (cmd === "run") {
  const opts = { variant: null, dryRun: false, instance: null, speculative: false, noProbe: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--variant") opts.variant = argv[++i];
    else if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i] === "--instance") opts.instance = argv[++i];
    else if (argv[i] === "--speculative") opts.speculative = true;
    else if (argv[i] === "--no-tool-probe") opts.noProbe = true;
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) die("usage: khdl-app run <app-dir> [--variant N] [--dry-run] [--instance NAME] [--speculative] [--no-tool-probe]");
  process.exit(runApp(resolve(rest[0]), opts));
} else if (cmd === "list") {
  // Default store root: this script lives in <root>/runtime/.
  process.exit(listStore(resolve(argv[0] || join(import.meta.dirname, ".."))));
} else {
  die("usage: khdl-app <run|list> …");
}
