"""Convert main.tex to main.docx (IEEE-style two-column layout).

Handles only the LaTeX subset main.tex uses. Run from this directory:
    python tex2docx.py
Needs python-docx.
"""
import re
import unicodedata
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

HERE = Path(__file__).parent
FONT = "Times New Roman"
COL_W = 3.43  # inches

MATH = {
    "geq": "≥", "ge": "≥", "leq": "≤", "le": "≤", "to": "→", "times": "×",
    "pm": "±", "tau": "τ", "delta": "δ", "lambda": "λ", "rho": "ρ", "alpha": "α",
    "Delta": "Δ", "sum": "∑", "quad": " ", "cdot": "·",
}
SYMS = {"S": "§", ",": "\u2009", ";": " ", " ": " ", "%": "%", "&": "&",
        "_": "_", "$": "$", "#": "#", "\\": " ", "-": ""}
ACCENTS = {"`": "\u0300", "'": "\u0301", "^": "\u0302", '"': "\u0308", "~": "\u0303"}


def read_group(s, i):
    """s[i] == '{'; return (content, index after the matching '}')."""
    depth, j = 0, i
    while j < len(s):
        if s[j] == "{" and (j == 0 or s[j - 1] != "\\"):
            depth += 1
        elif s[j] == "}" and (j == 0 or s[j - 1] != "\\"):
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
        j += 1
    raise ValueError("unbalanced braces: " + s[i:i + 40])


class Ctx:
    def __init__(self):
        self.labels = {}
        self.cites = {}


def math_runs(s, fmt):
    """Math-mode text to (text, fmt) runs; fmt is a frozenset of flags."""
    out, i = [], 0

    def emit(t, f):
        if t:
            out.append((t, f))

    def arg(i):
        while i < len(s) and s[i] == " ":
            i += 1
        if i < len(s) and s[i] == "{":
            return read_group(s, i)
        if i < len(s) and s[i] == "\\":
            m = re.match(r"\\([A-Za-z]+|.)", s[i:])
            return m.group(0), i + len(m.group(0))
        return s[i], i + 1

    while i < len(s):
        c = s[i]
        if c == "\\":
            m = re.match(r"\\([A-Za-z]+|.)", s[i:])
            name = m.group(1)
            i += len(m.group(0))
            if name in ("mathrm", "text", "mathit"):
                a, i = arg(i)
                emit(a, fmt)
            elif name == "frac":
                a, i = arg(i)
                b, i = arg(i)
                out += math_runs(a, fmt) + [("/", fmt)] + math_runs(b, fmt)
            elif name in MATH:
                emit(MATH[name], fmt)
            elif name in SYMS:
                emit(SYMS[name], fmt)
            else:
                emit(name, fmt)
        elif c in "_^":
            flag = "sub" if c == "_" else "sup"
            a, i = arg(i + 1)
            out += math_runs(a, fmt | {flag})
        elif c in "{}":
            i += 1
        elif c.isalpha():
            j = i
            while j < len(s) and s[j].isalpha():
                j += 1
            emit(s[i:j], fmt | {"i"})
            i = j
        else:
            emit("−" if c == "-" else c, fmt)
            i += 1
    return out


def inline(s, ctx, fmt=frozenset()):
    out, buf, i = [], [], 0

    def flush():
        if buf:
            t = "".join(buf)
            t = t.replace("---", "—").replace("--", "–")
            t = t.replace("``", "“").replace("''", "”").replace("'", "’")
            out.append((t, fmt))
            buf.clear()

    while i < len(s):
        c = s[i]
        if c == "$":
            j = s.index("$", i + 1)
            flush()
            out.extend(math_runs(s[i + 1:j], fmt))
            i = j + 1
        elif c == "\\":
            m = re.match(r"\\([A-Za-z]+|.)", s[i:], re.S)
            name = m.group(1)
            i += len(m.group(0))
            if name in ACCENTS:
                j = i
                if s[j] == "{":
                    ch, j = read_group(s, j)
                else:
                    ch, j = s[j], j + 1
                buf.append(unicodedata.normalize("NFC", ch + ACCENTS[name]))
                i = j
                continue
            if name in ("textbf", "emph", "textit", "textcolor"):
                if name == "textcolor":
                    _, i = read_group(s, i)
                a, i = read_group(s, i)
                flush()
                f = fmt | {"b" if name == "textbf" else "i"}
                out.extend(inline(a, ctx, f))
            elif name == "cite":
                a, i = read_group(s, i)
                buf.append(", ".join("[%d]" % ctx.cites[k.strip()] for k in a.split(",")))
            elif name == "ref":
                a, i = read_group(s, i)
                buf.append(ctx.labels.get(a, "??"))
            elif name == "label":
                _, i = read_group(s, i)
            elif name == "tbd":
                _, i = read_group(s, i)
                buf.append("[TBD]")
            elif name in SYMS:
                buf.append(SYMS[name])
            elif name in ("scriptsize", "centering"):
                pass
            else:
                buf.append(name)
        elif c == "~":
            buf.append("\u00a0")
            i += 1
        elif c in "{}":
            i += 1
        else:
            buf.append(c)
            i += 1
    flush()
    return out


def add_runs(p, runs, size=None, base=()):
    for text, f in runs:
        r = p.add_run(text)
        r.font.name = FONT
        r._element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
        if size:
            r.font.size = Pt(size)
        r.bold = ("b" in f) or ("b" in base) or None
        r.italic = ("i" in f) or ("i" in base) or None
        if "sub" in f:
            r.font.subscript = True
        if "sup" in f:
            r.font.superscript = True
    return p


def para(doc_or_cell, ctx, text, size=10, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
         first_indent=0.0, space_after=4, base=(), style=None):
    p = doc_or_cell.add_paragraph(style=style)
    pf = p.paragraph_format
    pf.alignment = align
    pf.first_line_indent = Inches(first_indent) if first_indent else None
    pf.space_after = Pt(space_after)
    pf.space_before = Pt(0)
    add_runs(p, inline(text, ctx), size, base)
    return p


# --------------------------------------------------------------------------
# Parsing main.tex
# --------------------------------------------------------------------------
def parse(tex):
    title = re.search(r"\\title\{(.*?)\}\s*\n\n?\\author", tex, re.S).group(1)
    title = " ".join(title.split())
    authors = []
    auth = tex[tex.index("\\author{"):tex.index("\\maketitle")]
    # Split author text into per-author chunks.
    chunks = re.split(r"\\and|\\linebreakand", auth[len("\\author{"):].rstrip().rstrip("}"))
    for ch in chunks:
        name = re.search(r"\\IEEEauthorblockN\{\\scriptsize (.*?)\}", ch, re.S).group(1)
        aff = ch[ch.index("\\IEEEauthorblockA{") + len("\\IEEEauthorblockA{"):].strip()
        aff = aff.rstrip("}").replace("\\scriptsize", "")
        lines = [re.sub(r"\\textit\{(.*?)\}", r"\1", l).replace("\\", "").strip()
                 for l in re.split(r"\\\\", aff)]
        authors.append((name.strip(), [l for l in lines if l]))
    abstract = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", tex, re.S).group(1)
    keywords = re.search(r"\\begin\{IEEEkeywords\}(.*?)\\end\{IEEEkeywords\}", tex, re.S).group(1)
    body = tex[tex.index("\\end{IEEEkeywords}") + len("\\end{IEEEkeywords}"):
               tex.index("\\begin{thebibliography}")]
    bib = tex[tex.index("\\begin{thebibliography}{00}") + len("\\begin{thebibliography}{00}"):
              tex.index("\\end{thebibliography}")]
    refs = re.findall(r"\\bibitem\{(.*?)\}\s*(.*?)(?=\n\s*\n|\Z)", bib, re.S)
    return title, authors, " ".join(abstract.split()), " ".join(keywords.split()), body, refs


def roman(n):
    out = ""
    for v, s in ((10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= v:
            out += s
            n -= v
    return out


def blocks_of(body, ctx):
    """Body to a block list; numbers sections/floats and fills ctx.labels."""
    blocks, par = [], []
    sec = sub = fig = tab = eq = 0
    lines = [l for l in body.split("\n") if not l.lstrip().startswith("%")]
    text = "\n".join(lines)
    pos, last = 0, None

    def flush():
        t = " ".join(" ".join(par).split())
        if t:
            blocks.append(("p", t))
        par.clear()

    pat = re.compile(r"\\section\{(.*?)\}|\\subsection\{(.*?)\}|\\label\{(.*?)\}|"
                     r"\\begin\{(equation|table|figure)\}(.*?)\\end\{\4\}|(\n\s*\n)", re.S)
    for m in pat.finditer(text):
        par.append(text[pos:m.start()])
        pos = m.end()
        if m.group(1):
            flush()
            sec += 1
            sub = 0
            last = roman(sec)
            blocks.append(("h1", "%s. %s" % (last, m.group(1).upper())))
        elif m.group(2):
            flush()
            sub += 1
            last = "%s-%s" % (roman(sec), chr(64 + sub))
            blocks.append(("h2", "%s. %s" % (chr(64 + sub), m.group(2))))
        elif m.group(3):
            ctx.labels[m.group(3)] = last
        elif m.group(4):
            flush()
            env, inner = m.group(4), m.group(5)
            lab = re.search(r"\\label\{(.*?)\}", inner)
            if env == "equation":
                eq += 1
                last = str(eq)
                blocks.append(("eq", inner.replace(lab.group(0), "").strip() if lab else inner.strip(), eq))
            elif env == "table":
                tab += 1
                last = roman(tab)
                blocks.append(("table", inner, tab))
            else:
                fig += 1
                last = str(fig)
                blocks.append(("figure", inner, fig))
            if lab:
                ctx.labels[lab.group(1)] = last
        else:
            flush()
    par.append(text[pos:])
    flush()
    return blocks


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------
def set_cols(section, n, space=360):
    sect = section._sectPr
    cols = sect.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        sect.append(cols)
    cols.set(qn("w:num"), str(n))
    cols.set(qn("w:space"), str(space))


def no_borders(table):
    tblPr = table._tbl.tblPr
    b = OxmlElement("w:tblBorders")
    for e in ("top", "left", "bottom", "right", "insideH", "insideV"):
        x = OxmlElement("w:" + e)
        x.set(qn("w:val"), "nil")
        b.append(x)
    tblPr.append(b)


def rule_borders(table):
    """booktabs-like: rules above, below and under the header row."""
    tblPr = table._tbl.tblPr
    b = OxmlElement("w:tblBorders")
    for e in ("top", "bottom"):
        x = OxmlElement("w:" + e)
        x.set(qn("w:val"), "single")
        x.set(qn("w:sz"), "8")
        b.append(x)
    tblPr.append(b)
    for c in table.rows[0].cells:
        tcPr = c._tc.get_or_add_tcPr()
        tb = OxmlElement("w:tcBorders")
        x = OxmlElement("w:bottom")
        x.set(qn("w:val"), "single")
        x.set(qn("w:sz"), "4")
        tb.append(x)
        tcPr.append(tb)


def render_table(doc, ctx, inner, num):
    cap = inner[inner.index("\\caption{") + 8:]
    cap, _ = read_group(cap, 0)
    p = para(doc, ctx, "TABLE %s" % roman(num), 8, WD_ALIGN_PARAGRAPH.CENTER, space_after=0)
    p.paragraph_format.keep_with_next = True
    p = para(doc, ctx, cap, 8, WD_ALIGN_PARAGRAPH.CENTER, space_after=3)
    p.paragraph_format.keep_with_next = True
    spec = re.search(r"\\begin\{tabular\}\{(.*?)\}", inner).group(1)
    align = {"l": WD_ALIGN_PARAGRAPH.LEFT, "c": WD_ALIGN_PARAGRAPH.CENTER, "r": WD_ALIGN_PARAGRAPH.RIGHT}
    aligns = [align[c] for c in spec if c in align]
    tb = inner[inner.index("}", inner.index("\\begin{tabular}") + 15) + 1:inner.index("\\end{tabular}")]
    tb = re.sub(r"\\(toprule|midrule|bottomrule)", "", tb)
    rows = [r.strip() for r in tb.split("\\\\") if r.strip()]
    cells = [[c.strip() for c in r.split("&")] for r in rows]
    t = doc.add_table(rows=len(cells), cols=len(aligns))
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for ri, row in enumerate(cells):
        for ci, txt in enumerate(row):
            cell = t.cell(ri, ci)
            cp = cell.paragraphs[0]
            cp.paragraph_format.alignment = aligns[ci]
            cp.paragraph_format.space_after = Pt(0)
            add_runs(cp, inline(txt, ctx), 7)
    no_borders(t)
    rule_borders(t)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def render_figure(doc, ctx, inner, num):
    m = re.search(r"\\includegraphics\[width=([\d.]*)\\columnwidth\]\{(.*?)\}", inner)
    frac = float(m.group(1) or 1)
    path = HERE / m.group(2)
    if path.suffix == ".pdf":
        path = path.with_suffix(".png")
    p = doc.add_paragraph()
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_after = Pt(2)
    p.add_run().add_picture(str(path), width=Inches(COL_W * frac))
    cap = inner[inner.index("\\caption{") + 8:]
    cap, _ = read_group(cap, 0)
    cap = " ".join(cap.split())
    para(doc, ctx, "Fig. %d. %s" % (num, cap), 8, WD_ALIGN_PARAGRAPH.CENTER, space_after=6)


def main():
    tex = (HERE / "main.tex").read_text(encoding="utf-8")
    title, authors, abstract, keywords, body, refs = parse(tex)
    ctx = Ctx()
    for i, (k, _) in enumerate(refs, 1):
        ctx.cites[k] = i
    blocks = blocks_of(body, ctx)

    doc = Document()
    s = doc.sections[0]
    s.page_width, s.page_height = Inches(8.5), Inches(11)
    s.left_margin = s.right_margin = Inches(0.7)
    s.top_margin, s.bottom_margin = Inches(0.75), Inches(0.75)
    st = doc.styles["Normal"]
    st.font.name = FONT
    st.font.size = Pt(10)
    for name in ("Heading 1", "Heading 2"):
        h = doc.styles[name]
        h.font.name = FONT
        h.font.color.rgb = RGBColor(0, 0, 0)
        h.font.bold = False
        h.font.size = Pt(10)

    # Title block
    p = doc.add_paragraph()
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(8)
    add_runs(p, [(title, frozenset())], 22)

    t = doc.add_table(rows=2, cols=4)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    no_borders(t)
    for idx, (name, aff) in enumerate(authors):
        cell = t.cell(idx // 4, idx % 4)
        cp = cell.paragraphs[0]
        cp.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cp.paragraph_format.space_after = Pt(0)
        add_runs(cp, [(name, frozenset())], 10)
        for line in aff:
            ap = cell.add_paragraph()
            ap.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            ap.paragraph_format.space_after = Pt(0)
            add_runs(ap, [(line, frozenset())], 7.5, base=("i",) if "Institute" in line or "School" in line or "and" == line[:3] or "Engineering" in line else ())
    doc.add_paragraph().paragraph_format.space_after = Pt(4)

    p = doc.add_paragraph()
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.space_after = Pt(4)
    add_runs(p, [("Abstract—", frozenset({"b", "i"}))] + [(t_, f | {"b"}) for t_, f in inline(abstract, ctx)], 9)
    p = doc.add_paragraph()
    p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.space_after = Pt(6)
    add_runs(p, [("Index Terms—", frozenset({"b", "i"}))] + [(t_, f | {"b"}) for t_, f in inline(keywords, ctx)], 9)

    # Two-column body
    sec2 = doc.add_section(WD_SECTION.CONTINUOUS)
    set_cols(sec2, 2)

    for b in blocks:
        kind = b[0]
        if kind == "h1":
            h = doc.add_paragraph(style="Heading 1")
            h.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            h.paragraph_format.space_before = Pt(8)
            h.paragraph_format.space_after = Pt(4)
            add_runs(h, [(b[1], frozenset())], 9.5)
        elif kind == "h2":
            h = doc.add_paragraph(style="Heading 2")
            h.paragraph_format.space_before = Pt(5)
            h.paragraph_format.space_after = Pt(3)
            add_runs(h, [(b[1], frozenset({"i"}))], 10)
        elif kind == "p":
            para(doc, ctx, b[1], 10, first_indent=0.17)
        elif kind == "eq":
            p = doc.add_paragraph()
            p.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_after = Pt(4)
            add_runs(p, inline("$" + b[1] + "$", ctx) + [("    (%d)" % b[2], frozenset())], 10)
        elif kind == "table":
            render_table(doc, ctx, b[1], b[2])
        elif kind == "figure":
            render_figure(doc, ctx, b[1], b[2])

    h = doc.add_paragraph(style="Heading 1")
    h.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER
    h.paragraph_format.space_before = Pt(8)
    add_runs(h, [("REFERENCES", frozenset())], 9.5)
    for i, (k, text) in enumerate(refs, 1):
        p = doc.add_paragraph()
        pf = p.paragraph_format
        pf.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        pf.left_indent = Inches(0.3)
        pf.first_line_indent = Inches(-0.3)
        pf.space_after = Pt(2)
        add_runs(p, [("[%d]\t" % i, frozenset())] + inline(" ".join(text.split()), ctx), 8)

    out = HERE / "main.docx"
    doc.save(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
