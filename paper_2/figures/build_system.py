"""Fig. 1 -- system architecture as a numbered data flow, drawn with matplotlib.

Single-column layout: the four stages (content-script extraction, service-worker
classifier cascade, HTTP generation service, offscreen playback) are stacked
top to bottom in one vertical strip, so the figure fits a single column
(figure, not figure*) rather than running the double-column width. Numbered
steps 1-9 read straight down the page from DOM to speaker. The two persistent
stores are drawn as cylinders exactly where they are touched: the IndexedDB
vector store next to the embedding step (cosine search for a revisit, upsert
of the new page), and the Postgres cache index inside the generation service
(lookup on every request, upsert after a successful save; Supabase-hosted in
production, a local container for every measurement in the paper), with the
audio objects themselves in a separate file/object store. Dashed red edges are
the only ones carrying page text off the device -- the hosted entailment API
and the hosted LLM, both behind the key proxy.
Run: python paper_2/figures/build_system.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.transforms as mtransforms  # noqa: E402
from matplotlib.patches import Arc, Circle, Ellipse, FancyBboxPatch, Polygon, Rectangle  # noqa: E402

HERE = Path(__file__).resolve().parent
INK, FAINT = "#14161E", "#6E7486"
DEV, DEV_E = "#EAF0F9", "#3B6FB6"
OFF, OFF_E = "#E6F2EE", "#2E8B6F"
NET, NET_E = "#FBE3E6", "#B03A48"
STOP, STOP_E = "#EDEEF1", "#6E7486"
DB, DB_E = "#FFF6DC", "#B8860B"

plt.rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["DejaVu Sans", "Arial"],
                     "pdf.fonttype": 42, "savefig.bbox": "tight", "savefig.pad_inches": 0.02})

W, H = 64, 122
YBOT = -4.5
fig, ax = plt.subplots(figsize=(3.42, 3.42 * (H - YBOT) / W))
fig.subplots_adjust(left=0, right=1, bottom=0, top=1)
ax.set_xlim(0, W)
ax.set_ylim(YBOT, H)
ax.set_aspect("equal")
ax.axis("off")
FS = 4.8


def shadow(x0, y0, x1, y1, r=0.7):
    ax.add_patch(FancyBboxPatch((x0 + 0.4, y0 - 0.4), x1 - x0, y1 - y0,
                                boxstyle=f"round,pad=0,rounding_size={r}",
                                fc="#00000014", ec="none", zorder=1.5))


def box(x0, y0, x1, y1, text, fc, ec, bold_first=True, ls="-", fs=FS):
    shadow(x0, y0, x1, y1)
    ax.add_patch(FancyBboxPatch((x0, y0), x1 - x0, y1 - y0, boxstyle="round,pad=0,rounding_size=0.7",
                                fc=fc, ec=ec, lw=1.0, ls=ls, zorder=2))
    lines = text.split("\n")
    if bold_first:
        ax.text((x0 + x1) / 2, y1 - 0.8, lines[0], ha="center", va="top", fontsize=fs + 0.4,
                fontweight="bold", color=INK, zorder=3)
        rest = "\n".join(lines[1:])
        if rest:
            ax.text((x0 + x1) / 2, y0 + 0.7, rest, ha="center", va="bottom", fontsize=fs,
                    color=INK, zorder=3, linespacing=1.22)
    else:
        ax.text((x0 + x1) / 2, (y0 + y1) / 2, text, ha="center", va="center", fontsize=fs,
                color=INK, zorder=3, linespacing=1.22)


def cylinder(cx, cy, w, h, title, sub, fc, ec, sub_pos="below", fs=FS, inner=None):
    """Datastore glyph: title inside the drum, `sub` either below or to the right."""
    eh = h * 0.30
    shadow(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r=w / 2)
    ax.add_patch(Rectangle((cx - w / 2, cy - h / 2 + eh / 2), w, h - eh, fc=fc, ec="none", zorder=2))
    ax.plot([cx - w / 2, cx - w / 2], [cy - h / 2 + eh / 2, cy + h / 2 - eh / 2], color=ec, lw=0.9, zorder=2.3)
    ax.plot([cx + w / 2, cx + w / 2], [cy - h / 2 + eh / 2, cy + h / 2 - eh / 2], color=ec, lw=0.9, zorder=2.3)
    ax.add_patch(Ellipse((cx, cy - h / 2 + eh / 2), w, eh, fc=fc, ec=ec, lw=0.9, zorder=2.2))
    ax.add_patch(Ellipse((cx, cy + h / 2 - eh / 2), w, eh, fc=fc, ec=ec, lw=0.9, zorder=2.4))
    ty = cy - eh * 0.35 + (0.9 if inner else 0)
    ax.text(cx, ty, title, ha="center", va="center", fontsize=fs, fontweight="bold",
            color=INK, zorder=3)
    if inner:
        ax.text(cx, ty - 1.9, inner, ha="center", va="center", fontsize=fs - 0.6, color=INK, zorder=3)
    if not sub:
        return
    if sub_pos == "below":
        ax.text(cx, cy - h / 2 - 0.5, sub, ha="center", va="top", fontsize=fs - 0.5, color=FAINT,
                zorder=3, linespacing=1.1)
    else:
        ax.text(cx + w / 2 + 0.9, cy, sub, ha="left", va="center", fontsize=fs - 0.4, color=INK,
                zorder=3, linespacing=1.15)


def cloud_icon(cx, cy, s, fc, ec):
    lobes = [(-0.45, -0.05, 0.42), (-0.15, 0.28, 0.5), (0.22, 0.26, 0.46), (0.5, -0.05, 0.4)]
    for dx, dy, r in lobes:
        ax.add_patch(Circle((cx + dx * s, cy + dy * s), r * s, fc=fc, ec="none", zorder=3.6))
    ax.add_patch(Rectangle((cx - 0.62 * s, cy - 0.42 * s), 1.3 * s, 0.5 * s, fc=fc, ec="none", zorder=3.6))
    for dx, dy, r in lobes:
        ax.add_patch(Circle((cx + dx * s, cy + dy * s), r * s, fc="none", ec=ec, lw=0.55, zorder=3.7, alpha=0.6))


def badge(cx, cy, r=1.2):
    ax.add_patch(Circle((cx, cy), r, fc="white", ec=FAINT, lw=0.5, zorder=3.5))


def lock_icon(cx, cy, s, ec):
    badge(cx, cy)
    ax.add_patch(Rectangle((cx - 0.4 * s, cy - 0.35 * s), 0.8 * s, 0.68 * s, fc="white", ec=ec, lw=0.65, zorder=4))
    ax.add_patch(Arc((cx, cy + 0.13 * s), 0.58 * s, 0.68 * s, theta1=0, theta2=180, ec=ec, lw=0.65, zorder=4))
    ax.add_patch(Circle((cx, cy - 0.05 * s), 0.07 * s, fc=ec, ec="none", zorder=4.1))


def chip_icon(cx, cy, s, ec):
    ax.add_patch(Rectangle((cx - 0.4 * s, cy - 0.4 * s), 0.8 * s, 0.8 * s, fc="white", ec=ec, lw=0.65, zorder=4))
    for i in (-0.22, 0, 0.22):
        ax.plot([cx + i * s, cx + i * s], [cy - 0.55 * s, cy - 0.4 * s], color=ec, lw=0.65, zorder=4)
        ax.plot([cx + i * s, cx + i * s], [cy + 0.4 * s, cy + 0.55 * s], color=ec, lw=0.65, zorder=4)
        ax.plot([cx - 0.55 * s, cx - 0.4 * s], [cy + i * s, cy + i * s], color=ec, lw=0.65, zorder=4)
        ax.plot([cx + 0.4 * s, cx + 0.55 * s], [cy + i * s, cy + i * s], color=ec, lw=0.65, zorder=4)


def question_icon(cx, cy, s, ec):
    badge(cx, cy)
    ax.add_patch(Circle((cx, cy), 0.42 * s, fc="white", ec=ec, lw=0.65, zorder=4))
    ax.text(cx, cy, "?", ha="center", va="center", fontsize=5.0, color=ec, fontweight="bold", zorder=4.1)


def shield_icon(cx, cy, s, ec):
    badge(cx, cy)
    pts = [(cx, cy + 0.5 * s), (cx + 0.38 * s, cy + 0.28 * s), (cx + 0.38 * s, cy - 0.2 * s),
           (cx, cy - 0.5 * s), (cx - 0.38 * s, cy - 0.2 * s), (cx - 0.38 * s, cy + 0.28 * s)]
    ax.add_patch(Polygon(pts, closed=True, fc="white", ec=ec, lw=0.65, zorder=4))
    ax.plot([cx - 0.14 * s, cx - 0.02 * s, cx + 0.18 * s], [cy - 0.02 * s, cy - 0.16 * s, cy + 0.18 * s],
            color=ec, lw=0.85, zorder=4.1, solid_capstyle="round")


def speaker_icon(cx, cy, s, ec):
    ax.add_patch(Polygon([(cx - 0.5 * s, cy - 0.2 * s), (cx - 0.5 * s, cy + 0.2 * s),
                          (cx - 0.15 * s, cy + 0.2 * s), (cx + 0.2 * s, cy + 0.5 * s),
                          (cx + 0.2 * s, cy - 0.5 * s), (cx - 0.15 * s, cy - 0.2 * s)],
                         closed=True, fc="white", ec=ec, lw=0.65, zorder=4))
    for r in (0.18, 0.32):
        ax.add_patch(Arc((cx + 0.2 * s, cy), r * s * 2, r * s * 2.6, theta1=-45, theta2=45,
                         ec=ec, lw=0.65, zorder=4))


def zone(y0, y1, title, fc, ec, icon, tx=4.1):
    ax.add_patch(FancyBboxPatch((1, y0), 59, y1 - y0, boxstyle="round,pad=0,rounding_size=1.1",
                                fc=fc, ec=ec, lw=1.0, ls=(0, (4, 2)), zorder=0.2))
    icon(tx, y1 - 1.9, 1.4, ec)
    ax.text(tx + 2.2, y1 - 2.5, title, ha="left", va="bottom", fontsize=5.8, fontweight="bold", color=ec, zorder=3)


def arrow(pts, label=None, ls="-", color=INK, lpos=None, lw=0.85, lfs=4.1, lha="center", lva="bottom", rot=0):
    xs, ys = zip(*pts)
    if len(pts) > 2:
        ax.plot(xs[:-1], ys[:-1], ls=ls, color=color, lw=lw, zorder=4, solid_capstyle="round")
    ax.annotate("", xy=pts[-1], xytext=pts[-2],
                arrowprops={"arrowstyle": "-|>", "color": color, "lw": lw, "ls": ls,
                            "shrinkA": 0, "shrinkB": 0, "mutation_scale": 6.0}, zorder=4)
    if label:
        lx, ly = lpos if lpos else ((xs[-1] + xs[-2]) / 2, (ys[-1] + ys[-2]) / 2)
        ax.text(lx, ly, label, fontsize=lfs, color=color, ha=lha, va=lva, zorder=5, rotation=rot,
                bbox={"fc": "white", "ec": "none", "pad": 0.3})


class Shifted:
    """Draw a block of the diagram translated by (dx, dy) data units, so a whole
    zone can be relocated without rewriting every coordinate literal inside it."""

    def __init__(self, ax, dx, dy):
        self.ax = ax
        self.offset = mtransforms.Affine2D().translate(dx, dy) + ax.transData

    def __enter__(self):
        self._add_patch, self._text, self._plot, self._annotate = (
            self.ax.add_patch, self.ax.text, self.ax.plot, self.ax.annotate)

        def add_patch(p):
            p.set_transform(self.offset)
            return self._add_patch(p)

        def text(x, y, s, **kw):
            return self._text(x, y, s, transform=self.offset, **kw)

        def plot(xs, ys, *a, **kw):
            return self._plot(xs, ys, *a, transform=self.offset, **kw)

        def annotate(*a, **kw):
            kw.setdefault("xycoords", self.offset)
            kw.setdefault("textcoords", self.offset)
            return self._annotate(*a, **kw)

        self.ax.add_patch, self.ax.text, self.ax.plot, self.ax.annotate = add_patch, text, plot, annotate
        return self

    def __exit__(self, *exc):
        self.ax.add_patch, self.ax.text, self.ax.plot, self.ax.annotate = (
            self._add_patch, self._text, self._plot, self._annotate)


# ── 1. content script + offscreen extraction ────────────────────────────────
zone(100.5, 120, "CONTENT SCRIPT + OFFSCREEN WORKER (extraction)", "#F7F9FC", DEV_E, chip_icon)
box(3, 109, 33, 115.5, "1  Descriptor extractor\nDOM → text, colour, behaviour,\nreadability (86 ms/page)", DEV, DEV_E)
box(36, 109, 59, 115.5, "2  Sentence embedding\nMiniLM, 384-d, in-browser ONNX", DEV, DEV_E)
lock_icon(57.6, 116.2, 1.2, DEV_E)
arrow([(33, 112.2), (36, 112.2)])
cylinder(40.0, 104.6, 8.5, 4.6, "IndexedDB", "cosine search → revisit\nflag; upsert this page",
         DB, DB_E, sub_pos="right")
arrow([(38.0, 109), (38.0, 107.0)], ls="-")
arrow([(42.0, 107.0), (42.0, 109)], ls="-")
ax.text(37.1, 108.0, "search", fontsize=3.8, ha="right", va="center", color=FAINT)
ax.text(42.9, 108.0, "upsert", fontsize=3.8, ha="left", va="center", color=FAINT)

# ── 2. service worker: classifier cascade ────────────────────────────────────
zone(59.5, 98.5, "SERVICE WORKER (classifier cascade)", "#F7F9FC", DEV_E, chip_icon, tx=23)
arrow([(18, 109), (18, 94.4)], "page descriptor", lpos=(19, 101.5), lha="left", lva="center")

dc = (18, 90.2)
ax.add_patch(Polygon([(dc[0] - 8.5, dc[1]), (dc[0], dc[1] + 4.2), (dc[0] + 8.5, dc[1]), (dc[0], dc[1] - 4.2)],
                     closed=True, fc="white", ec=INK, lw=0.9, zorder=2))
ax.text(dc[0], dc[1], "sensitive /\npayment /\nchrome://?", ha="center", va="center",
        fontsize=FS - 0.3, zorder=3, linespacing=1.1)
box(40, 87.2, 59, 93.2, "Silence / bypass\nno request leaves the device", STOP, STOP_E)
shield_icon(57.4, 93.9, 1.3, STOP_E)
arrow([(26.5, 90.2), (40, 90.2)], "yes", lpos=(33, 90.8))
arrow([(18, 86.0), (18, 84.2)], "no", lpos=(17, 85.1), lha="right")

box(3, 74.4, 20, 84.2, "3a  Keyword\ncat.: text only\nmood: text+colour\n+behaviour bias\nstop if conf $\\geq$ 0.5", DEV, DEV_E)
lock_icon(18.6, 84.9, 1.2, DEV_E)
box(22, 74.4, 39, 84.2, "3b  Zero-shot NLI\nabstains unless\nscore $\\geq$ 0.45,\nmargin $\\geq$ 0.10\nhosted/local ONNX", DEV, DEV_E)
question_icon(37.6, 84.9, 1.2, DEV_E)
box(41, 74.4, 58, 84.2, "3c  Remote LLM\n8 s timeout\nfalls back to 3a\non failure", DEV, DEV_E)
arrow([(20, 79.3), (22, 79.3)], "escalate", lpos=(21, 80.0), lfs=3.7)
arrow([(39, 79.3), (41, 79.3)], "abstain", lpos=(40, 80.0), lfs=3.7)

# hosted endpoints (off-device), directly under the two stages that call them
box(26, 66.6, 39, 71.4, "Entailment API\nhosted, via key proxy", NET, NET_E, ls=(0, (4, 2)), fs=FS - 0.3)
cloud_icon(38.0, 72.0, 0.8, NET, NET_E)
box(45, 66.6, 58, 71.4, "LLM API\nhosted, via key proxy", NET, NET_E, ls=(0, (4, 2)), fs=FS - 0.3)
cloud_icon(57.0, 72.0, 0.8, NET, NET_E)
arrow([(32.5, 74.4), (32.5, 71.4)], "page text", ls="--", color=NET_E, lpos=(33.3, 72.9), lfs=3.6, lha="left", lva="center")
arrow([(51.5, 74.4), (51.5, 71.4)], "page text", ls="--", color=NET_E, lpos=(52.3, 72.9), lfs=3.6, lha="left", lva="center")

box(3, 61.0, 59, 65.6, "4  Confidence window: mood holds 5 s → music profile → prompt", DEV, DEV_E, bold_first=False)
arrow([(11.5, 74.4), (11.5, 65.6)], ls=":")
arrow([(23.5, 74.4), (23.5, 65.6)], ls=":")
arrow([(42.5, 74.4), (42.5, 65.6)], ls=":")

# ── vertical continuation: generation service + playback, same column below ─
arrow([(30, 61.0), (30, 55.5)], "generation request", lpos=(31, 58.3), lha="left", lva="center")

with Shifted(ax, 0, -2.5):
    # ── 3. generation service ────────────────────────────────────────────────
    zone(22.5, 58.0, "GENERATION SERVICE (HTTP, off-device)", "#FCF3F4", NET_E,
         lambda x, y, s, ec: cloud_icon(x, y, s * 0.9, NET, ec), tx=21.5)

    box(3, 46.4, 22, 52.6, "5  Validate profile\ncache key: mood/style/key\n+ bucketed fields", NET, NET_E, fs=FS - 0.3)
    cylinder(31, 49.5, 9.5, 6.2, "Postgres", "", DB, DB_E, inner="audio_cache")
    box(41, 46.4, 59, 52.6, "Return audio URL\n+ loop point + metadata", NET, NET_E)
    arrow([(22, 49.5), (26.5, 49.5)], "lookup", lpos=(24.2, 50.2), lfs=3.6)
    arrow([(35.5, 49.5), (41, 49.5)], "hit", lpos=(38.2, 50.2), lfs=3.6)

    box(3, 36.0, 22, 43.4, "6  MusicGen-small\nbatching worker\n(cold: minutes on CPU)", NET, NET_E, fs=FS - 0.3)
    box(25, 36.0, 46, 43.4, "7  Loop synthesis\nself-similarity cut, 50 ms\ncrossfade, −18 LUFS, Opus", NET, NET_E, fs=FS - 0.3)
    cylinder(54, 39.7, 8, 5.4, "Files", "object store\n(.ogg clips)", DB, DB_E, sub_pos="below")
    arrow([(29, 46.7), (29, 45.0), (12.5, 45.0), (12.5, 43.4)], "miss", lpos=(20, 45.4), lfs=3.6)
    arrow([(22, 39.7), (25, 39.7)])
    arrow([(46, 39.7), (50, 39.7)], "save", lpos=(48, 40.3), lfs=3.6)
    arrow([(35.5, 43.4), (35.5, 45.0), (33, 45.0), (33, 46.7)], "upsert", lpos=(36.2, 44.6), lfs=3.6, lha="left", lva="center")
    arrow([(54, 42.4), (54, 46.4)], "URL", lpos=(54.8, 44.4), lfs=3.6, lha="left", lva="center")

    box(3, 26.0, 59, 31.4, "8  Any stage fails → per-mood fallback clip (11 clips);\nalso served first, instantly, on every request", STOP, STOP_E, bold_first=False)
    arrow([(8, 36.0), (8, 31.4)], "fail", lpos=(8.8, 33.7), lfs=3.6, lha="left", lva="center")
    arrow([(40, 36.0), (40, 31.4)], "fail", lpos=(40.8, 33.7), lfs=3.6, lha="left", lva="center")

    # ── 4. offscreen playback ────────────────────────────────────────────────
    zone(3.8, 21.0, "OFFSCREEN DOCUMENT (playback)", "#F2F8F5", OFF_E, speaker_icon, tx=27)
    box(3, 11.6, 28, 17.4, "9a  Fallback clip\naudible in ~7 ms", OFF, OFF_E)
    box(31, 11.6, 59, 17.4, "9b  Generated clip crossfades in\nabort-on-stale: new mood cancels it", OFF, OFF_E)
    box(3, 5.2, 59, 9.8, "Player: two decks, gapless loop point → gain / effects", OFF, OFF_E, bold_first=False)
    speaker_icon(57.0, 7.5, 1.3, OFF_E)
    arrow([(15, 26.0), (15, 17.4)], "fallback clip", lpos=(15.9, 21.7), lfs=3.8, lha="left", lva="center")
    arrow([(59, 49.5), (61.6, 49.5), (61.6, 14.5), (59, 14.5)], "generated clip + loop point", color=INK,
          lpos=(62.5, 32), lfs=3.6, rot=90, lha="center", lva="center")
    arrow([(15, 11.6), (15, 9.8)])
    arrow([(45, 11.6), (45, 9.8)])

# ── legend, two rows, single-column width ────────────────────────────────────
ly1, ly2 = -1.0, -3.2
ax.plot([3.5, 7.5], [ly1, ly1], color=INK, lw=0.85)
ax.text(8.2, ly1, "control / data flow", fontsize=3.9, va="center")
ax.plot([34, 38], [ly1, ly1], color=INK, lw=0.85, ls=":")
ax.text(38.7, ly1, "terminal stage", fontsize=3.9, va="center")
ax.plot([3.5, 7.5], [ly2, ly2], color=NET_E, lw=0.85, ls="--")
ax.text(8.2, ly2, "page text leaves device", fontsize=3.9, va="center")
ax.add_patch(Ellipse((36.7, ly2), 3.2, 1.1, fc=DB, ec=DB_E, lw=0.7))
ax.text(39.4, ly2, "persistent store", fontsize=3.9, va="center")

fig.savefig(HERE / "system.pdf")
fig.savefig(HERE / "system.png", dpi=300)
print("wrote system.pdf / system.png")
