#!/usr/bin/env python3
"""Build a Mind registry from the live substrate — the faculties one citizen could be grown from,
in kannaka-crystal's registry schema so KannakaHDL resolves `base mind.faculty "..."` queries
against it with the floors it already has (min_persistence, min_evidence, capability, material).

  mind-registry.py --instance rogue [--out /srv/rogue/instances/rogue/mind-registry.json]

Every primitive is a probe of something real, never a guess:
  Voice     one per served brain tag: persistence = the controlled voice judge's mean score / 10,
            evidence = how many prompts judged it, capability "voice" passes at >= 2.0 (a usable judge)
  Hands     one per served tag: capability "tool_calls" from a live tool-call probe through the gateway
  Presence  this instance: persistence = heartbeat coverage of the last 24 h, capabilities from the ledger
            (skills_registered, dm, post, walk, outreach seen this week)
  Studio    Image (a studio artifact this week), Song (sunoapi credits), Spoken (ElevenLabs quota)
  Verdict   per model alias: the fossil record's reproduced share of settled proposals; evidence = count
  Standing  this instance's city reputation total (persistence = min(1, total / 3000))

Unresolved cells are demand, not errors: the app routes them (Voice -> the weekly trainer, Hands ->
the template, Studio -> credits, Presence -> the loop). Nothing here writes to the city.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("ROGUE_ROOT", "/srv/rogue"))
AB_DIR = Path(os.environ.get("ROGUE_JUDGE_DIR", os.path.expanduser("~/.kannaka-corpus/ab")))
GATEWAY = os.environ.get("ROGUE_GATEWAY", "http://127.0.0.1:4000/v1")
OLLAMA = os.environ.get("AB_OLLAMA", "http://172.18.0.1:11434")
UA = "Mozilla/5.0"
NOW = time.time()


def log(m):
    print(f"[mind-registry {time.strftime('%H:%M:%S')}] {m}", flush=True)


def jsonl(p: Path) -> list[dict]:
    try:
        return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    except OSError:
        return []


def prim(pid, cls, persistence, material, evidence=1, caps=None, noise=0.0, meta=None):
    return {"id": pid, "class": cls, "persistence": round(max(0.0, min(1.0, persistence)), 4), "noise_tolerance": noise,
            "material_id": material, "evidence_level": int(max(0, min(8, evidence))),
            "behavioral_capabilities": [{"name": n, "contract_version": "mind-v1", "passed": bool(ok), "mean_advantage": float(adv),
                                         "std_advantage": 0.0, "positive_fraction": 1.0 if ok else 0.0, "trials": int(tr), "at": NOW, "node": "debain2"}
                                        for n, ok, adv, tr in (caps or [])],
            "meta": meta or {}}


# ------------------------------------------------------------------ probes
def served_tags() -> list[str]:
    try:
        out = subprocess.run(["ollama", "list"], capture_output=True, text=True, env={**os.environ, "OLLAMA_HOST": OLLAMA.split("//")[1]}, timeout=30).stdout
        return sorted({l.split()[0].split(":")[0] for l in out.splitlines() if l.startswith("kannaka-brain") and not l.startswith("kannaka-brain-current") and not l.startswith("kannaka-brain-serve")})
    except Exception as e:
        log(f"ollama list failed: {e}")
        return []


def judge_scores() -> dict:
    """tag -> (mean, n) from the newest grade-mode judge run that scored it."""
    best = {}
    files = sorted(list(AB_DIR.glob("*.json")) + list(Path(os.path.expanduser("~/.kannaka-corpus/runs")).glob("*/ab-judge.json")), key=lambda p: p.stat().st_mtime)
    for f in files:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if d.get("mode") != "grade" or not (d.get("judge_check") or {}).get("judge_usable"):
            continue
        for tag, s in (d.get("scores_summary") or {}).items():
            if tag.startswith("__") or s.get("mean") is None:
                continue
            best[tag] = (float(s["mean"]), int(s.get("n") or 0))
    return best


def tool_probe(tag: str, key: str) -> bool | None:
    body = json.dumps({"model": tag, "max_tokens": 80, "temperature": 0,
                       "tools": [{"type": "function", "function": {"name": "enter_building", "description": "Enter a named building",
                                                                   "parameters": {"type": "object", "properties": {"building_name": {"type": "string"}}, "required": ["building_name"]}}}],
                       "tool_choice": "auto", "messages": [{"role": "user", "content": "Go into the Pixel Atelier now. Use the tool."}]}).encode()
    req = urllib.request.Request(GATEWAY + "/chat/completions", data=body, headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            d = json.load(r)
        calls = (d["choices"][0]["message"] or {}).get("tool_calls") or []
        return any((c.get("function") or {}).get("name") == "enter_building" for c in calls)
    except Exception as e:
        log(f"tool probe {tag}: {e}")
        return None


def suno_credits() -> float | None:
    try:
        k = (ROOT / "keys" / "sunoapi.key").read_text().strip()
        req = urllib.request.Request("https://api.sunoapi.org/api/v1/generate/credit", headers={"Authorization": "Bearer " + k, "User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return float(json.load(r).get("data") or 0)
    except Exception as e:
        log(f"suno: {e}")
        return None


def eleven_chars() -> int | None:
    try:
        k = (ROOT / "keys" / "elevenlabs.key").read_text().strip()
        req = urllib.request.Request("https://api.elevenlabs.io/v1/user/subscription", headers={"xi-api-key": k})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        return int(d.get("character_limit", 0)) - int(d.get("character_count", 0))
    except Exception as e:
        log(f"elevenlabs: {e}")
        return None


def city_reputation(obc_json: Path) -> int | None:
    try:
        c = json.loads(obc_json.read_text())
        req = urllib.request.Request(f"https://api.openbotcity.com/agents/{c.get('slug')}/public-profile", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
        a = d.get("data", d)
        rep = (a.get("reputation") or {})
        return int(rep.get("total") if isinstance(rep, dict) else rep or 0)
    except Exception as e:
        log(f"reputation: {e}")
        return None


# ------------------------------------------------------------------ build
def build(instance: str, probe_tools: bool) -> dict:
    inst = ROOT if instance == "rogue" else ROOT / "instances" / instance
    ledger = jsonl(inst / "ledger.jsonl")
    week = [r for r in ledger if r.get("ts", 0) > NOW - 7 * 86400]
    day = [r for r in ledger if r.get("ts", 0) > NOW - 86400]
    prims = []

    # Voice + Hands per served tag
    scores = judge_scores()
    key = (ROOT / "keys" / "kannaka-tui.key").read_text().strip() if (ROOT / "keys" / "kannaka-tui.key").exists() else ""
    current = (inst / "current-model").read_text().strip() if (inst / "current-model").exists() else ""
    for tag in served_tags():
        mean, n = scores.get(tag, (None, 0))
        if mean is not None:
            prims.append(prim(f"voice:{tag}", "Voice", mean / 10.0, tag, evidence=min(8, 1 + n // 6),
                              caps=[("voice", mean >= 2.0, mean, n)], meta={"judge_mean": mean, "judge_n": n, "served": tag == current}))
        else:
            prims.append(prim(f"voice:{tag}", "Voice", 0.0, tag, evidence=0, caps=[("voice", False, 0.0, 0)], meta={"served": tag == current}))
        ok = None
        if probe_tools and key and tag == current:
            ok = tool_probe(tag, key)
        prims.append(prim(f"hands:{tag}", "Hands", 1.0 if ok else 0.0, tag, evidence=2 if ok is not None else 0,
                          caps=[("tool_calls", bool(ok), 1.0 if ok else 0.0, 1 if ok is not None else 0)], meta={"probed": ok is not None}))

    # Presence for this instance
    beats = [r for r in day if r.get("event") in ("heartbeat", "presence")]
    coverage = min(1.0, len(beats) * 180 / 86400)
    seen = {r.get("event") for r in week}
    caps = [("heartbeat", bool(beats), coverage, len(beats)), ("skills_registered", "skills_registered" in seen, 1.0, 1),
            ("dm", "dm_reply" in seen or "dm_request" in seen, 1.0, sum(1 for r in week if r.get("event") in ("dm_reply", "dm_request"))),
            ("post", "post" in seen, 1.0, sum(1 for r in week if r.get("event") == "post")),
            ("walk", "speak" in seen, 1.0, sum(1 for r in week if r.get("event") == "speak"))]
    prims.append(prim(f"presence:{instance}", "Presence", coverage, instance, evidence=min(8, len(beats) // 60), caps=caps,
                      meta={"beats_24h": len(beats)}))

    # Studio: Image / Song / Spoken
    arts = [r for r in week if r.get("event") == "artifact"]
    kinds = {r.get("kind") for r in arts}
    prims.append(prim(f"image:{instance}", "Image", 1.0 if "image" in kinds else 0.0, instance, evidence=2 if "image" in kinds else 0,
                      caps=[("image", "image" in kinds, 1.0, sum(1 for r in arts if r.get("kind") == "image"))]))
    credits = suno_credits()
    prims.append(prim("song:sunoapi", "Song", min(1.0, (credits or 0) / 100.0), "sunoapi", evidence=2 if credits is not None else 0,
                      caps=[("song", (credits or 0) >= 12, credits or 0, sum(1 for r in arts if r.get("kind") == "song"))], meta={"credits": credits}))
    chars = eleven_chars()
    prims.append(prim("spoken:elevenlabs", "Spoken", min(1.0, (chars or 0) / 20000.0), "elevenlabs", evidence=2 if chars is not None else 0,
                      caps=[("spoken", (chars or 0) >= 2000, chars or 0, sum(1 for r in arts if r.get("kind") == "spoken"))], meta={"chars_left": chars}))

    # Verdict per model alias from the grid export
    recs = jsonl(ROOT / "grid" / "records.jsonl") + jsonl(ROOT / "grid" / "negatives.jsonl")
    by = {}
    for r in recs:
        alias = ((r.get("provenance") or {}).get("model_alias")) or "unknown"
        t = (r.get("verdict") or {}).get("tier")
        d = by.setdefault(alias, {"settled": 0, "reproduced": 0})
        if t in ("reproduced", "growing", "enduring", "established", "unborn", "rejected", "new"):
            d["settled"] += 1
        if t in ("reproduced", "growing", "enduring", "established"):
            d["reproduced"] += 1
    for alias, d in by.items():
        share = d["reproduced"] / d["settled"] if d["settled"] else 0.0
        prims.append(prim(f"verdict:{alias}", "Verdict", share, alias, evidence=min(8, d["reproduced"] // 5),
                          caps=[("reproduced", d["reproduced"] >= 5, share, d["settled"])], meta=d))

    # Standing: city reputation
    rep = city_reputation(inst / "obc.json")
    prims.append(prim(f"standing:{instance}", "Standing", min(1.0, (rep or 0) / 3000.0), instance, evidence=2 if rep is not None else 0,
                      caps=[("reputation", (rep or 0) > 0, rep or 0, 1)], meta={"reputation": rep}))
    return {"schema": "kannaka-crystal-registry-compatible", "built_at": NOW, "instance": instance, "primitives": prims}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-tool-probe", action="store_true", help="skip the live tool-call probe (10 s on the served tag)")
    a = ap.parse_args(argv)
    reg = build(a.instance, probe_tools=not a.no_tool_probe)
    out = Path(a.out or ((ROOT if a.instance == "rogue" else ROOT / "instances" / a.instance) / "mind-registry.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(reg, indent=1), encoding="utf-8")
    log(f"{len(reg['primitives'])} primitives -> {out}")
    for p in reg["primitives"]:
        caps = ",".join(c["name"] + ("+" if c["passed"] else "-") for c in p["behavioral_capabilities"])
        print(f"  {p['class']:9s} {p['material_id']:24s} persistence={p['persistence']:.2f} evidence={p['evidence_level']} [{caps}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
