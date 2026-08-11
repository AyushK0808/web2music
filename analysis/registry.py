"""C-01 — the metrics registry, and the check that makes the plan's §0 rule mechanical.

RESULTS_AND_DISCUSSION_PLAN.md §0 says: "no claim in §6 may rest on a number that
no script in §5 produces", and §4 is the table that is supposed to enforce it.
A table in a markdown file enforces nothing. This module loads that table from
``metrics.json`` and refuses to let a figure declare a metric that is not in it.

Every artefact module in ``analysis/figures/`` exposes:

    ARTEFACT = Artefact(id="T1", kind="table", title=..., metrics=[...], inputs=[...])
    def build(ctx) -> dict      # returns the numbers it wrote, for the sidecar

``build_all.py`` imports them, validates the declared metric ids against the
registry, checks the declared inputs exist, and runs the ones whose inputs are
on disk. Anything else is reported as blocked with the reason, which is how the
inventory in §6 of the plan stays honest without anyone maintaining it by hand.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ANALYSIS = REPO / "analysis"
OUT = ANALYSIS / "out"


class UnregisteredMetric(KeyError):
    """Raised when an artefact declares a metric id that metrics.json does not define."""


@dataclass(frozen=True)
class Metric:
    id: str
    definition: str
    units: str
    producer: str
    field: str
    status: str
    blocked_on: str | None = None
    caveat: str | None = None


class Registry:
    def __init__(self, path: Path | None = None):
        self.path = path or (ANALYSIS / "metrics.json")
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.schema_version = raw["schema_version"]
        self._metrics: dict[str, Metric] = {}
        for rec in raw["metrics"]:
            m = Metric(
                id=rec["id"],
                definition=rec["definition"],
                units=rec["units"],
                producer=rec["producer"],
                field=rec.get("field", ""),
                status=rec["status"],
                blocked_on=rec.get("blocked_on"),
                caveat=rec.get("caveat"),
            )
            if m.id in self._metrics:
                raise ValueError(f"duplicate metric id in {self.path.name}: {m.id}")
            self._metrics[m.id] = m

    def __contains__(self, metric_id: str) -> bool:
        return metric_id in self._metrics

    def __getitem__(self, metric_id: str) -> Metric:
        try:
            return self._metrics[metric_id]
        except KeyError:
            raise UnregisteredMetric(
                f"{metric_id!r} is not in {self.path.name}. A figure may not consume a "
                f"metric with no provenance row — add it to metrics.json with the script "
                f"that produces it, or stop plotting it."
            ) from None

    def require(self, metric_ids) -> list[Metric]:
        """Fail loudly, and all at once, on any unregistered id."""
        missing = [m for m in metric_ids if m not in self._metrics]
        if missing:
            raise UnregisteredMetric(
                f"unregistered metric id(s): {', '.join(sorted(missing))}. "
                f"Add a provenance row to {self.path.name} or drop the metric."
            )
        return [self._metrics[m] for m in metric_ids]

    def ids(self) -> list[str]:
        return list(self._metrics)

    def all(self) -> list[Metric]:
        return list(self._metrics.values())


@dataclass
class Artefact:
    """One table or figure from the plan's §6 inventory."""

    id: str
    kind: str  # "table" | "figure"
    title: str
    metrics: list[str]
    inputs: list[str]  # repo-relative paths that must exist to build it
    section: str = ""  # the paper section it lands in
    priority: int = 99  # plan §6 cut order; lower survives longer
    notes: str = ""


@dataclass
class Context:
    """Handed to every ``build``. Resolves inputs and records what was written."""

    registry: Registry
    artefact: Artefact
    outdir: Path
    written: list[Path] = field(default_factory=list)

    def input_path(self, rel: str) -> Path:
        p = REPO / rel
        if not p.exists():
            raise FileNotFoundError(f"{self.artefact.id}: declared input missing: {rel}")
        return p

    def load_json(self, rel: str):
        return json.loads(self.input_path(rel).read_text(encoding="utf-8"))

    def metric(self, metric_id: str) -> Metric:
        """Look a metric up. Raises if the artefact did not declare it."""
        if metric_id not in self.artefact.metrics:
            raise UnregisteredMetric(
                f"{self.artefact.id} used metric {metric_id!r} without declaring it in "
                f"ARTEFACT.metrics — declare it so the provenance table stays true."
            )
        return self.registry[metric_id]

    def path(self, suffix: str) -> Path:
        self.outdir.mkdir(parents=True, exist_ok=True)
        p = self.outdir / f"{self.artefact.id.lower()}{suffix}"
        self.written.append(p)
        return p


def missing_inputs(artefact: Artefact) -> list[str]:
    return [rel for rel in artefact.inputs if not (REPO / rel).exists()]
