"""L-9 — every number in the paper must trace to a file a script wrote.

    python analysis/numbers_diff.py --list            # print every number the check sees, with context
    python analysis/numbers_diff.py                   # verify against paper/numbers.json
    python analysis/numbers_diff.py --tex paper/main.tex --registry paper/numbers.json --require-ack
    python analysis/numbers_diff.py --self-test

paper/numbers.json maps a number as printed in the paper to where it comes from:

    { "numbers": {
        "0.689": {"source": "mood-classification/results/s2-ablation-a6-full.json",
                  "pointer": "configs.A6b.macro_f1", "decimals": 3},
        "38":    {"source": "analysis/out/s_e_dev_test.json",
                  "pointer": "test.A6b_local_llm.off_device_rate", "scale": 100, "decimals": 0}
      },
      "exempt": {"5": "confidence window, a design constant (feature_b/index.js)"} }

For each entry the script loads `source`, follows `pointer` (dotted keys and
[index] / [key=value] selectors), multiplies by `scale`, rounds to `decimals` and
compares with the printed number. A number printed in the paper that is neither
registered nor exempt is an error, so a figure typed in by hand cannot survive.

Ignored automatically: single-digit integers, years (1900-2099), references,
labels, citations, file names and LaTeX control arguments.

`--require-ack` also checks that the acknowledgements disclose AI-assisted
language editing (IEEE policy).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

STRIP_ARG_COMMANDS = ("cite", "citep", "citet", "ref", "eqref", "label", "includegraphics", "usepackage",
                      "documentclass", "bibitem", "bibliographystyle", "bibliography", "input", "url",
                      "href", "begin", "end", "cmidrule", "setlength", "hline", "vspace", "hspace",
                      "renewcommand", "newcommand", "pagestyle", "thispagestyle")
NUM_RE = re.compile(r"(?<![\w.\\])(\d+(?:\.\d+)?)(?![\w])")


def tex_prose(tex: str) -> str:
    """The text a reader sees: comments, bibliography, preamble and command arguments removed."""
    body = tex.split(r"\begin{document}", 1)[-1]
    body = body.split(r"\begin{thebibliography}", 1)[0]
    body = re.sub(r"(?<!\\)%.*", "", body)
    for cmd in STRIP_ARG_COMMANDS:
        body = re.sub(r"\\" + cmd + r"\*?(\[[^\]]*\])?\{[^}]*\}(\{[^}]*\})?", " ", body)
    body = re.sub(r"\$[^$]*\$", " MATH ", body)        # inline math: equation constants are not claims
    body = re.sub(r"\\begin\{(equation|align)\*?\}.*?\\end\{\1\*?\}", " MATH ", body, flags=re.S)
    return body


def extract_numbers(tex: str):
    """[(printed, line_no, context)] for every number a reader sees."""
    out = []
    for n, line in enumerate(tex_prose(tex).splitlines(), 1):
        for m in NUM_RE.finditer(line):
            s = m.group(1)
            if "." not in s and (len(s) == 1 or (len(s) == 4 and 1900 <= int(s) <= 2099)):
                continue
            out.append((s, n, line.strip()[:110]))
    return out


# ── pointer resolution ───────────────────────────────────────────────────────

TOKEN_RE = re.compile(r"([^.\[\]]+)|\[(\d+)\]|\[([^=\]]+)=([^\]]+)\]")


def resolve(data, pointer: str):
    cur = data
    for m in TOKEN_RE.finditer(pointer):
        key, idx, sk, sv = m.groups()
        if key is not None:
            cur = cur[key]
        elif idx is not None:
            cur = cur[int(idx)]
        else:
            matches = [x for x in cur if str(x.get(sk)) == sv]
            if len(matches) != 1:
                raise KeyError(f"[{sk}={sv}] matched {len(matches)} items")
            cur = matches[0]
    return cur


def check(tex: str, registry: dict, repo: Path = REPO):
    """Returns (unregistered, mismatched, stale) lists."""
    numbers, exempt = registry.get("numbers", {}), registry.get("exempt", {})
    seen = extract_numbers(tex)
    printed = {s for s, _, _ in seen}
    unregistered = [(s, ln, ctx) for s, ln, ctx in seen if s not in numbers and s not in exempt]

    mismatched, cache = [], {}
    for s, spec in numbers.items():
        try:
            src = repo / spec["source"]
            data = cache.setdefault(str(src), json.loads(src.read_text(encoding="utf-8")))
            val = resolve(data, spec["pointer"]) * spec.get("scale", 1)
            got = round(val, spec.get("decimals", 0))
            want = float(s)
            if abs(got - want) > 1e-9:
                mismatched.append((s, f"{spec['source']}:{spec['pointer']} = {got}"))
        except Exception as e:
            mismatched.append((s, f"cannot resolve {spec.get('source')}:{spec.get('pointer')} ({type(e).__name__}: {e})"))
    stale = sorted(s for s in numbers if s not in printed)
    return unregistered, mismatched, stale


def _self_test():
    import tempfile
    tex = r"""\documentclass{article}\begin{document}
We report macro-F1 of 0.689 (2024) with a 5 s window and 38\% less disclosure, 0.700 hand typed.
\cite{ref12} \label{fig:3}  % 0.999 in a comment
\begin{thebibliography}{9}\bibitem{x} 1234 pages\end{thebibliography}\end{document}"""
    nums = [s for s, _, _ in extract_numbers(tex)]
    assert nums == ["0.689", "38", "0.700"], nums
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        (td / "r.json").write_text(json.dumps({"configs": [{"name": "A6b", "macro_f1": 0.68912}], "off": 0.381}))
        reg = {"numbers": {"0.689": {"source": "r.json", "pointer": "configs[name=A6b].macro_f1", "decimals": 3},
                           "38": {"source": "r.json", "pointer": "off", "scale": 100, "decimals": 0},
                           "99": {"source": "r.json", "pointer": "off"}},
               "exempt": {}}
        un, mis, stale = check(tex, reg, td)
        assert [u[0] for u in un] == ["0.700"], un
        assert [m[0] for m in mis] == ["99"] and stale == ["99"], (mis, stale)
        reg["numbers"]["0.689"]["pointer"] = "off"
        _, mis, _ = check(tex, reg, td)
        assert any(m[0] == "0.689" for m in mis), "a registered number that no longer matches its source must fail"
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tex", default="paper/main.tex")
    ap.add_argument("--registry", default="paper/numbers.json")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--require-ack", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        _self_test()
        return 0

    tex = (REPO / args.tex).read_text(encoding="utf-8")
    if args.list:
        for s, ln, ctx in extract_numbers(tex):
            print(f"{s:>8}  L{ln:<4} {ctx}")
        return 0

    reg_path = REPO / args.registry
    registry = json.loads(reg_path.read_text(encoding="utf-8")) if reg_path.exists() else {"numbers": {}, "exempt": {}}
    unregistered, mismatched, stale = check(tex, registry)
    ok = True
    if unregistered:
        ok = False
        print(f"{len(unregistered)} number(s) printed in the paper with no source:")
        for s, ln, ctx in unregistered:
            print(f"  {s:>8}  L{ln}: {ctx}")
    if mismatched:
        ok = False
        print(f"{len(mismatched)} registered number(s) that do not match their source:")
        for s, why in mismatched:
            print(f"  {s:>8}  {why}")
    if stale:
        print(f"note: {len(stale)} registry entr(ies) no longer appear in the paper: {', '.join(stale)}")
    if args.require_ack and not re.search(r"(AI|language model|LLM)[- ]assisted|generative AI", tex, re.I):
        ok = False
        print("acknowledgements do not disclose AI-assisted editing (IEEE policy)")
    print("numbers-diff: OK" if ok else "numbers-diff: FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
