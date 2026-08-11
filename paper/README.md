# Web2Music — paper draft bundle

Drafted against the repository at commit `a492ec5`.

```
main.tex            The paper. IEEEtran conference, 6 authors, 41 references.
SUPPLEMENTARY.md    Everything outstanding — the paper carries no draft markup.
Makefile            `make` to build, `make clean`.
figures/            7 figures: 3 mermaid architecture diagrams + 4 data figures.
diagrams/           Mermaid sources + the renderer that turns them into vector PDFs.
source-tables/      The markdown/LaTeX tables emitted by analysis/build_all.py.
```

## Sections

Introduction · Related Work · Research Gaps and Problem Statement ·
System Architecture · Results and Discussion · Conclusion · Limitations ·
Future Scope · References

## Building

```
make          # pdflatex x2 -> main.pdf
make clean
```

`main.tex` has **not** been compiled — no LaTeX toolchain was available when it
was written. It is structurally validated (balanced environments, no undefined
refs or cites, all figure targets present), but expect a first-build fix.

## Reading it honestly

The paper prints no red markup, so the provenance of every number lives in
[`SUPPLEMENTARY.md`](SUPPLEMENTARY.md) §0. In short:

- **Measured**: extraction cost (105 sites), generation latency (144 requests),
  loop quality (141 clips), the restraint audit (20-page adversarial slice),
  the cost model, and the retrieval-coverage analysis.
- **Preliminary, and flagged as such in the text**: the tier ablation, from an
  18-page development subset with a single annotator.
- **Excluded from the paper entirely**: everything built from simulated
  listeners or synthetic sessions — the loop AB test, the user study tables,
  and the in-the-wild figure.

`python analysis/build_all.py` from the repo root reports 7 of 13 artefacts
built and 6 blocked; the blocked six are the user study, the deployment, and
everything downstream of annotating the corpus.

## Regenerating the figures

```
python analysis/build_all.py        # from the repo root -> figures/f1,f2,f3,f6
cd diagrams && node render_mermaid.mjs ../figures   # -> pipeline, cascade, featured
```

The mermaid renderer drives the repo's existing Playwright Chromium and prints
to PDF, so the architecture diagrams are vector rather than bitmap. It needs a
mermaid 10.x UMD bundle saved as `diagrams/mermaid10.js` (not committed —
3.3 MB); any CDN mirror will do.
