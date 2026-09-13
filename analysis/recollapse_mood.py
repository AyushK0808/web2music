"""Item 42: re-collapse mood post hoc at 3-way and 2-way, from the raw
annotator files, using the *same* analyse() function (same coincidence-
matrix alpha, same bootstrap CI, same missing-value handling) krippendorff.py
already uses for the 11-way figure -- not a reimplementation.

Mapping is a judgment call the item doesn't fully specify, stated here
plainly rather than hidden in code:

3-way (arousal-based; bucket names are the item's own):
  calm       <- calm, sad, nostalgic          (low arousal)
  neutral    <- focused, curious, neutral      (mid arousal)
  energetic  <- joyful, energetic, uplifting, tense, dark   (high arousal)

2-way (valence-based; not named by the item, chosen as the standard
complement to the arousal-based 3-way split above):
  positive <- calm, focused, joyful, energetic, curious, uplifting, neutral
  negative <- sad, dark, tense, nostalgic
"""
import json
import glob
import sys
sys.path.insert(0, ".")
from krippendorff import analyse

MOOD_3WAY = {
    "calm": "calm", "sad": "calm", "nostalgic": "calm",
    "focused": "neutral", "curious": "neutral", "neutral": "neutral",
    "joyful": "energetic", "energetic": "energetic", "uplifting": "energetic",
    "tense": "energetic", "dark": "energetic",
}
MOOD_2WAY = {
    "calm": "positive", "focused": "positive", "joyful": "positive",
    "energetic": "positive", "curious": "positive", "uplifting": "positive",
    "neutral": "positive",
    "sad": "negative", "dark": "negative", "tense": "negative", "nostalgic": "negative",
}

annotations = [json.loads(open(f).read()) for f in sorted(glob.glob("annotations-*.json"))]

for ann in annotations:
    for pid, lab in ann["labels"].items():
        m = lab.get("mood")
        lab["mood_3way"] = MOOD_3WAY.get(m) if m else None
        lab["mood_2way"] = MOOD_2WAY.get(m) if m else None

report = analyse(annotations, label_sets=("mood", "mood_3way", "mood_2way"), resamples=2000)

print(f"{report['n_annotators']} annotators, {report['n_units']} units\n")
for label in ("mood", "mood_3way", "mood_2way"):
    r = report[label]
    lo, hi = r["alpha_ci95"]
    print(f"  {label:<12} alpha={r['alpha']:.3f}  95% CI [{lo:.3f}, {hi:.3f}]  {r['gate']}")
    print(f"               human ceiling {r.get('leave_one_out_accuracy', r.get('ceiling', '?'))}"
          if 'leave_one_out_accuracy' in r or 'ceiling' in r else "", end="")
    print(f"               discard_rate={r['discard_rate']:.3f}")
    if label == "mood":
        print(f"               distribution: {r.get('distribution')}")

json.dump(report, open("recollapse_report.json", "w"), indent=2, default=str)

print()
cleared = [l for l in ("mood", "mood_3way", "mood_2way") if report[l]["alpha"] is not None and report[l]["alpha"] >= 0.667]
if cleared:
    print(f"alpha clears 0.667 at: {cleared}")
else:
    print("alpha does NOT clear 0.667 at any resolution tested (11-way, 3-way, 2-way).")
