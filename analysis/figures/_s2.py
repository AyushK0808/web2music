"""Shared loading for the three S2 artefacts (T2, F4, F5).

The real corpus does not exist yet (D-01/D-02), so these three artefacts are
blocked in a normal build. They are still written as working code rather than
stubs, and they can be exercised today against the 18-page smoke run:

    W2M_S2_RESULTS=mood-classification/results/s2-ablation-smoke.json \
        python analysis/build_all.py --only T2 F4 F5

Anything produced that way is a harness check, not a result. ``smoke`` is
carried through into every sidecar and caption so a figure built from the smoke
file cannot be mistaken for one built from the corpus.
"""

from __future__ import annotations

import os

DEFAULT = "mood-classification/results/s2-ablation.json"


def s2_results_path() -> str:
    return os.environ.get("W2M_S2_RESULTS", DEFAULT)


def is_smoke(path: str) -> bool:
    return "smoke" in path


def smoke_warning(path: str, n: int) -> str:
    if not is_smoke(path):
        return ""
    return (f"BUILT FROM THE SMOKE CORPUS (n={n}, one annotator, no Krippendorff's alpha). "
            f"Not reportable. Rebuild against the frozen 600-page corpus from D-02.")
