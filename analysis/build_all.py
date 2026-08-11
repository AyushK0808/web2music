"""C-01 — build every table and figure the plan's §6 inventory lists.

    python analysis/build_all.py            # build what the data supports
    python analysis/build_all.py --check    # validate declarations only, build nothing
    python analysis/build_all.py --only T1 F6

Exit status is non-zero only on a *declaration* error — an artefact naming a
metric that ``metrics.json`` does not define, or a build that raises. Missing
input data is not an error; it is the normal state of a paper in progress, and
it is reported as a blocked row with the reason so the inventory is always an
accurate picture of what exists.
"""

from __future__ import annotations

import argparse
import importlib
import json
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analysis.registry import (  # noqa: E402
    ANALYSIS, Context, OUT, Registry, UnregisteredMetric, missing_inputs,
)

MODULES = [
    "analysis.figures.t1_latency",
    "analysis.figures.f1_timeline",
    "analysis.figures.f2_duration_rtf",
    "analysis.figures.f3_batching",
    "analysis.figures.t2_tier_ablation",
    "analysis.figures.f4_confusion",
    "analysis.figures.f5_exposure_tradeoff",
    "analysis.figures.f6_seam",
    "analysis.figures.t3_loop_ab",
    "analysis.figures.f7_fit",
    "analysis.figures.t4_workload",
    "analysis.figures.f8_wild",
    "analysis.figures.t5_audit",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="validate declarations, build nothing")
    ap.add_argument("--only", nargs="*", default=None, help="artefact ids to build")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    registry = Registry()
    outdir = Path(args.out)
    results, declaration_errors = [], []

    for modname in MODULES:
        try:
            mod = importlib.import_module(modname)
        except Exception:
            declaration_errors.append(f"{modname}: import failed\n{traceback.format_exc()}")
            continue

        art = getattr(mod, "ARTEFACT", None)
        if art is None:
            declaration_errors.append(f"{modname}: no ARTEFACT")
            continue

        # The C-01 check: every declared metric must have a provenance row.
        try:
            metrics = registry.require(art.metrics)
        except UnregisteredMetric as e:
            declaration_errors.append(f"{art.id}: {e}")
            continue

        row = {
            "id": art.id, "kind": art.kind, "title": art.title, "section": art.section,
            "priority": art.priority, "metrics": art.metrics, "inputs": art.inputs,
            "notes": art.notes,
            "metric_status": {m.id: m.status for m in metrics},
        }

        if args.only and art.id not in args.only:
            row["status"] = "skipped"
            results.append(row)
            continue

        missing = missing_inputs(art)
        if missing:
            blockers = sorted({m.blocked_on for m in metrics if m.blocked_on})
            row["status"] = "blocked"
            row["missing_inputs"] = missing
            row["blocked_on"] = blockers
            results.append(row)
            continue

        if args.check:
            row["status"] = "ok (check only)"
            results.append(row)
            continue

        ctx = Context(registry=registry, artefact=art, outdir=outdir)
        try:
            row["values"] = mod.build(ctx)
            row["status"] = "built"
            row["written"] = [str(p.relative_to(outdir.parent)) for p in ctx.written]
        except UnregisteredMetric as e:
            declaration_errors.append(f"{art.id}: {e}")
            row["status"] = "declaration error"
        except Exception:
            row["status"] = "failed"
            row["error"] = traceback.format_exc()
        results.append(row)

    outdir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "registry_schema": registry.schema_version,
        "n_metrics": len(registry.ids()),
        "artefacts": results,
        "declaration_errors": declaration_errors,
    }
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str), encoding="utf-8")
    _write_inventory(outdir, results, registry)

    width = max(len(r["title"]) for r in results) if results else 20
    print(f"{'ID':<4} {'STATUS':<9} TITLE")
    for r in sorted(results, key=lambda r: (r["priority"], r["id"])):
        print(f"{r['id']:<4} {r['status']:<9} {r['title'][:width]}")
        if r["status"] == "blocked":
            print(f"     -> waiting on: {', '.join(r.get('blocked_on') or r['missing_inputs'])}")
        if r["status"] == "failed":
            print(f"     -> {r['error'].strip().splitlines()[-1]}")

    built = sum(1 for r in results if r["status"] == "built")
    failed = [r for r in results if r["status"] == "failed"]
    print(f"\n{built} built, {sum(1 for r in results if r['status'] == 'blocked')} blocked, "
          f"{len(failed)} failed  ->  {outdir}")

    for e in declaration_errors:
        print(f"\nDECLARATION ERROR: {e}", file=sys.stderr)
    if failed:
        for r in failed:
            print(f"\nBUILD FAILURE {r['id']}:\n{r['error']}", file=sys.stderr)
    return 1 if (declaration_errors or failed) else 0


def _write_inventory(outdir: Path, results, registry) -> None:
    """The plan's §6 table, regenerated from what actually built."""
    lines = ["# Figure and table inventory", "",
             "Generated by `analysis/build_all.py`. Do not edit by hand.", "",
             "| ID | Kind | §  | Title | Status | Waiting on |",
             "|---|---|---|---|---|---|"]
    for r in sorted(results, key=lambda r: (r["priority"], r["id"])):
        waiting = ", ".join(r.get("blocked_on") or r.get("missing_inputs") or []) or "—"
        lines.append(f"| {r['id']} | {r['kind']} | {r['section'] or '—'} | {r['title']} | "
                     f"{r['status']} | {waiting} |")
    lines += ["", "## Metrics with no artefact consuming them", ""]
    used = {m for r in results for m in r["metrics"]}
    orphans = [m for m in registry.ids() if m not in used]
    lines.append(", ".join(f"`{m}`" for m in orphans) if orphans
                 else "None — every registered metric is consumed by at least one artefact.")
    (outdir / "INVENTORY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
