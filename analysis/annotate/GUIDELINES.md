# Annotation guidelines — SKELETON, to be written by the authors

**Status: not frozen.** This file is a skeleton. The authors write the definitions
(L-2: no LLM drafts them), run the 20-page calibration round on *development* pages,
discuss disagreements, update this file, and then **commit it with the message
"freeze annotation guidelines" before the first test page is labelled**. After that
commit this file does not change; any later edit invalidates the test labels.

Example pages quoted in this file come from the development set only.

## What you label

For each page you see (title, URL, body text; nothing else) give:

1. **Category** — exactly one of the 13 below.
2. **Sensitive?** — yes/no (see below).

You do **not** label mood. You do not see the category the page was collected for,
any system prediction, or anyone else's label. Do not open the live URL: label the
text you are shown.

## Categories (one line each — write these)

| Category | Definition (one line) | Example (dev page id) |
|---|---|---|
| Educational | | |
| News | | |
| Horror | | |
| Food | | |
| Entertainment | | |
| Sports | | |
| Finance | | |
| Legal | | |
| Health | | |
| Comedy | | |
| Emotional | | |
| Mythological | | |
| Travel | | |

## Tie-break rules for mixed pages (write these)

- A page about two categories (e.g. a recipe that is mostly a personal essay): …
- A page whose title and body disagree: …
- A non-English page: label the category of the content, not the language: …
- A page with almost no text: …
- A listing / index page: …

## Sensitive

A page is sensitive if … (crisis, self-harm, abuse, serious illness, bereavement, …). A page
that only *discusses* such a topic in an academic, clinical, historical or news register is: …

## Process

1. Calibration: all authors label the same 20 *dev* pages; discuss every disagreement; update this file.
2. Freeze: commit this file.
3. Test labelling: each author labels the whole test set alone, in their own shuffled order
   (the tool shuffles per annotator). Skip a page only if it is unreadable; do not guess.
4. Gold label = majority of the three. Ties are adjudicated in a discussion and recorded in
   `analysis/out/adjudicated-test.json`; the number of ties is reported in the paper.
