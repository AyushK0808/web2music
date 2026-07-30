"""
Unit tests for d1_validate.py's validate_profile(), covering the
content_category empty-string regression from review.
"""
from models import HandoffPayload
from d1_validate import validate_profile


def test_content_category_empty_string_is_preserved_in_profile_branch():
    """
    Regression test: content_category was using `p.get("content_category")
    or "general"` instead of the `is not None else` pattern every other
    optional field in this mapping uses. If B ever sends
    content_category: "", `or` collapses it to "general" -- the exact
    silent-defaulting bug this whole commit exists to eliminate, just
    scoped to one field.
    """
    payload = HandoffPayload(profile={
        "mood": "calm", "bpm": 90, "key": "C major", "energy": 0.5,
        "style": "ambient", "content_category": "",
    })
    profile, _ = validate_profile(payload)
    assert profile["content_category"] == "", (
        f"empty-string content_category was collapsed to a default "
        f"(got {profile['content_category']!r})"
    )


def test_content_category_missing_defaults_to_general_in_profile_branch():
    """The other half of the fix: content_category truly absent (not just
    falsy) should still default to 'general', same as before."""
    payload = HandoffPayload(profile={
        "mood": "calm", "bpm": 90, "key": "C major", "energy": 0.5,
        "style": "ambient",
    })
    profile, _ = validate_profile(payload)
    assert profile["content_category"] == "general"


def test_content_category_empty_string_is_preserved_in_flat_dict_branch():
    """Same fix, same bug, in the flat-dict Swagger path (no profile/
    musicProfile wrapper -- top-level fields directly on HandoffPayload)."""
    payload = HandoffPayload(
        mood="calm", bpm=90, key="C major", energy=0.5,
        style="ambient", content_category="",
    )
    profile, _ = validate_profile(payload)
    assert profile["content_category"] == ""


def test_content_category_missing_defaults_to_general_in_flat_dict_branch():
    payload = HandoffPayload(mood="calm", bpm=90, key="C major", energy=0.5, style="ambient")
    profile, _ = validate_profile(payload)
    assert profile["content_category"] == "general"
