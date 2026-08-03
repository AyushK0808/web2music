/**
 * moodSites.js — the corpus the Chromium e2e harness browses.
 *
 * One page per mood in B2's MOODS enum (b2_moodClassifier.js), plus one
 * sensitive page that must produce silence rather than a mood. These are
 * served from a local HTTP server by harnessServer.mjs and browsed for real
 * by chromiumExtension.e2e.mjs, so every page goes through the actual
 * content-script path: Readability, Textextractor, Colorextractor and
 * behaviorTracker all run in a real renderer, not jsdom.
 *
 * ── Why the prose is written the way it is ─────────────────────────────────
 * The harness asserts an exact mood per page, so each page has to resolve on
 * tier-1 alone (the LLM is stubbed to 503 — see harnessServer.mjs — precisely
 * so a running/absent classify proxy can't change the answer). tier1KeywordMood
 * tokenises with /\b[a-z]{3,}\b/ and counts EXACT matches against MOOD_RULES,
 * so the copy below deliberately uses the literal keyword forms ("celebrate",
 * not "celebrated"; "gentle", not "gently") and deliberately avoids the other
 * moods' vocabulary. Each page lands ~20 hits on its own mood and ~0 on the
 * rest, which puts it far outside the ±0.3 that colour and behaviour bias can
 * contribute — those signals are exercised for real but can never flip the
 * assertion.
 *
 * Two constraints worth knowing before editing the prose:
 *   - `neutral` only comes out neutral if NOTHING scores: no mood keyword, no
 *     colour bias (hue must miss all four bands in colourMoodBias — 180° does),
 *     no behaviour bias (scroll and cursor both 0), low reading complexity.
 *     Common words like "how", "why", "work", "old", "run" and "charge" are all
 *     mood keywords; the recycling notice avoids every one of them on purpose.
 *   - `sad` must NOT trip B1's sensitive detector. checkSensitiveContent needs
 *     2+ distinct AMBIGUOUS_SENSITIVE_TERMS, so the memorial page uses "grief"
 *     (one term, any number of times) and never "bereavement"/"trauma"/
 *     "depression"/"abuse". "grieving" and "bereft" don't match those
 *     word-boundary regexes, so they're safe.
 */

// Behaviour profiles the harness drives with real mouse/wheel input while the
// page is open. Thresholds are behaviourMoodBias's (b2_moodClassifier.js):
// scroll >800 → tense, scroll <100 (and >0) → focused/calm, cursor >600 →
// energetic. `still` means the harness touches nothing, so behaviorTracker's
// readings decay to 0 — which is what `neutral` needs.
export const BEHAVIOURS = {
  STILL: "still",
  SLOW_READ: "slow-read", // ~75 px/s scroll
  FAST_SCROLL: "fast-scroll", // ~2000 px/s scroll
  FAST_CURSOR: "fast-cursor", // ~1000 px/s cursor
  BROWSE: "browse", // unremarkable mid-range movement
};

/**
 * renderSite — wraps a site's body copy in the shared page chrome.
 *
 * The heartbeat script at the bottom is load-bearing: Feature B only commits
 * a mood once the same candidate has held for confidenceWindowMs (5s), which
 * needs at least two A_PAGE_DATA handoffs on the tab. The content script
 * re-extracts on DOM churn (throttled MutationObserver, 2s), so appending an
 * empty, hidden node every 2.2s makes each page drive its own re-extraction
 * instead of the harness having to poke the DOM on a timer from outside. The
 * node is empty and display:none so it can never alter extracted text.
 */
export function renderSite(site) {
  return `<html lang="en">
<head>
<meta charset="utf-8">
<title>${site.title}</title>
<meta name="description" content="${site.description}">
<style>
  html, body { margin: 0; padding: 0; }
  body { background-color: ${site.bodyBg}; font-family: Georgia, serif; color: ${site.textColor}; }
  .site-nav, .site-footer { padding: 12px 32px; background-color: ${site.bodyBg}; }
  article.post-body { background-color: ${site.articleBg}; padding: 40px 32px; max-width: 760px; margin: 0 auto; line-height: 1.6; }
  h1 { font-size: 2rem; margin: 0 0 1rem; }
  p { margin: 0 0 1.2rem; }
  /* Scroll room, so the harness can drive real wheel input on every page. */
  .spacer { height: 320vh; background-color: ${site.bodyBg}; }
</style>
</head>
<body>
  <nav class="site-nav"><a href="/">Home</a> · <a href="/">Sections</a></nav>
  <article class="post-body">
    <h1>${site.heading}</h1>
    ${site.paragraphs.map((p) => `<p>${p}</p>`).join("\n    ")}
  </article>
  <footer class="site-footer">${site.footer}</footer>
  <div class="spacer"></div>
  <div id="w2m-heartbeat" style="display:none"></div>
  <script>
    // See renderSite's doc comment — this exists to keep Feature A
    // re-extracting so B's 5s confidence window can actually close.
    setInterval(function () {
      var host = document.getElementById("w2m-heartbeat");
      host.appendChild(document.createElement("span"));
      if (host.childNodes.length > 4) host.removeChild(host.firstChild);
    }, 2200);
  </script>
</body>
</html>`;
}

export const SITES = [
  {
    name: "calm_forest_bathing",
    expectedMood: "calm",
    behaviour: BEHAVIOURS.SLOW_READ,
    // Sage green (hue ~132) → colourMoodBias adds calm +0.15, uplifting +0.10.
    bodyBg: "rgb(232, 241, 234)",
    articleBg: "rgb(150, 190, 160)",
    textColor: "rgb(28, 40, 32)",
    title: "Forest Bathing: A Leisurely Guide to Stillness",
    description:
      "An unhurried guide to walking under trees — relax, breathe, and let the woods soothe you into a peaceful, restful calm.",
    heading: "Forest Bathing: A Leisurely Guide to Stillness",
    footer: "Wellness writing for people who would rather sit down.",
    paragraphs: [
      `Forest bathing asks nothing of you except that you slow down. Walk beneath the trees at a
       leisurely pace and let the quiet of the woods soothe whatever you carried in with you.
       Breathe. The air here is soft and cool, and the stillness of a stand of tall pines is
       enough to unwind a week of noise without anyone having to suggest it.`,
      `You do not need to meditate, though a great many people meditate here without meaning to.
       Simply let the gentle rhythm of walking ease your attention outward — the serene green
       light, the placid surface of a pond, the mellow hush under the canopy. Nature does the
       rest of it. This is a peaceful, restful hour, and it asks for no effort at all.`,
      `Come back often enough and the calm becomes portable. People describe a composed,
       tranquil steadiness that lasts well past the walk itself: a quiet harmony between body
       and surroundings, an unhurried balance that no amount of scrolling has ever supplied.
       Relax into it. There is nothing here that needs finishing, and no one is timing you.`,
    ],
  },

  {
    name: "focused_deep_work",
    expectedMood: "focused",
    behaviour: BEHAVIOURS.SLOW_READ,
    // Deep blue (hue ~219) → calm +0.20, focused +0.15.
    bodyBg: "rgb(236, 239, 246)",
    articleBg: "rgb(60, 90, 160)",
    textColor: "rgb(245, 247, 252)",
    title: "Structuring a Deep Work Block: A Practical Method",
    description:
      "A methodical approach to deep work: one task, one priority, and a schedule that makes concentration the default rather than the exception.",
    heading: "Structuring a Deep Work Block",
    footer: "Notes on method, for people who make things.",
    paragraphs: [
      `A deep work block is a fixed span of time dedicated to one task and nothing else. The
       method is deliberately methodical: pick a single priority, remove every interruption,
       and concentrate until the timer ends. Most people find they can sustain genuine focus
       for ninety minutes before the returns fall away sharply.`,
      `Before the block begins, organize the desk and the tabs. Decide what finished looks like.
       If the task is to write code, name the function you intend to build; if it is to study,
       name the chapter. This planning takes four minutes and makes the entire difference
       between an efficient session and an hour of expensive drift.`,
      `Discipline here is structural, not moral. Put the block on the schedule the night before.
       Keep a short analysis at the end: what you got done, measured against what you meant to
       execute. Diligent people are rarely the ones with more willpower — they are the ones
       whose deadline, strategy, and research notes are written down where they can see them.`,
    ],
  },

  {
    name: "joyful_festival_recap",
    expectedMood: "joyful",
    behaviour: BEHAVIOURS.BROWSE,
    // Very light (lightness ~0.89) → joyful +0.20, energetic +0.10; warm hue
    // (~47) adds energetic +0.15, joyful +0.10.
    bodyBg: "rgb(255, 250, 225)",
    articleBg: "rgb(255, 245, 200)",
    textColor: "rgb(60, 45, 10)",
    title: "The Village Festival That Ended in Fireworks and Laughter",
    description:
      "A festive night on the square: a party the whole village turned out for, and an organising committee left thrilled, elated and slightly hoarse.",
    heading: "The Village Festival That Ended in Fireworks and Laughter",
    footer: "Community reporting from the square.",
    paragraphs: [
      `The village square has not been this festive in a decade. By eight o'clock the whole
       street was a party — bunting, brass, and a genuinely amazing turnout that left the
       organisers thrilled and, by their own admission, a little ecstatic about numbers nobody
       had dared predict in March.`,
      `Children ran the sack race and the laughter carried three streets over. There was a
       cheerful, playful disorder to the evening: someone's terrier took the fancy-dress prize,
       the tug-of-war ended in a delighted heap, and nobody minded in the slightest. It was, in
       the end, simply fun.`,
      `By the fireworks the mood was jubilant. Neighbours who had not spoken in years stood
       together to celebrate a small, ordinary success — one year of a committee that nearly
       folded twice. Congratulations were shouted, badly, at an elated chairwoman. It was a
       happy, upbeat night, and the joy of it will carry the village to next summer. People
       love this festival, and last night it showed.`,
    ],
  },

  {
    name: "energetic_hiit_circuit",
    expectedMood: "energetic",
    behaviour: BEHAVIOURS.FAST_CURSOR,
    // Warm orange (hue ~19) → energetic +0.15, joyful +0.10; fast cursor adds
    // energetic +0.15.
    bodyBg: "rgb(255, 243, 235)",
    articleBg: "rgb(230, 100, 40)",
    textColor: "rgb(255, 248, 244)",
    title: "The 30-Minute HIIT Circuit That Actually Works You",
    description:
      "A gym workout of short, explosive intervals: sprint rounds, a vigorous finisher, and enough adrenaline to make thirty minutes feel considerably longer.",
    heading: "The 30-Minute HIIT Circuit",
    footer: "Training content for people who own a stopwatch.",
    paragraphs: [
      `This is a thirty-minute gym workout arranged around a single idea: intense effort in
       short, explosive bursts. Every round is a challenge — sprint intervals, fast burpees,
       and a vigorous finisher that will pump your heart rate straight to the ceiling and hold
       it there longer than you expect.`,
      `The adrenaline arrives about four minutes in. Keep the momentum. Drive through the last
       set even when the power drops off, because that is precisely where the energy adaptation
       happens: a surge of output your body has to grow new capacity to match, rather than one
       it can borrow from a warm-up.`,
      `The grind is the entire point. Hustle through the final ninety seconds, charge the last
       hill, and let the circuit force an active, robust response out of a system that would
       much rather coast. Run it three times a week and the boost carries into everything else
       you do. Dynamic warm-ups first, always — no exceptions on this one.`,
    ],
  },

  {
    name: "sad_in_memoriam",
    expectedMood: "sad",
    behaviour: BEHAVIOURS.SLOW_READ,
    // Desaturated slate — low saturation adds calm/neutral +0.10 each, which
    // ~23 sad keyword hits comfortably outrun.
    bodyBg: "rgb(228, 229, 233)",
    articleBg: "rgb(105, 110, 125)",
    textColor: "rgb(244, 245, 248)",
    title: "In Memoriam: Remembering a Friend of This Parish",
    description:
      "A tribute written in sorrow — on loss, on mourning someone woven into an ordinary week, and on the plain arithmetic of everything they will miss.",
    heading: "In Memoriam",
    footer: "Tributes, published with the family's permission.",
    paragraphs: [
      `We are gathered here in grief. The loss of a friend at fifty-one is a death that makes no
       sense at all, and the sorrow in this room tonight is the plain, unglamorous kind — tears,
       long silences, and the sad arithmetic of everything he will now miss: two weddings, one
       grandchild, and the end of a cricket season he had opinions about.`,
      `Those who knew him best describe an ache that arrives in the most ordinary moments. The
       empty chair. The joke nobody else will get. That is the particular heartache of mourning
       someone woven tightly into a daily routine — you feel lonely in a crowded room, and you
       feel bereft standing at your own kitchen sink on a Tuesday.`,
      `There is no instruction for grieving well. Some days bring anguish and a hopeless,
       forlorn flatness; others bring a milder melancholy and something close to steadiness. We
       mourn together because the alternative is to hurt alone. The pain does not resolve, it is
       carried, and we carry it for one another. Do not be ashamed to cry, or to weep openly, or
       to regret the telephone call you did not make.`,
    ],
  },

  {
    name: "dark_slasher_retrospective",
    expectedMood: "dark",
    behaviour: BEHAVIOURS.BROWSE,
    // Near-black (lightness ~0.07) → dark +0.30, tense +0.20. The tense bias is
    // deliberate: this page proves keyword evidence beats a colour prior.
    bodyBg: "rgb(12, 11, 14)",
    articleBg: "rgb(18, 16, 20)",
    textColor: "rgb(214, 210, 218)",
    title: "Fifty Years of the Slasher: A Horror Retrospective",
    description:
      "The most disreputable corner of horror, reconsidered — a grim formula, a sinister quarter-hour, and a villain who kept changing shape.",
    heading: "Fifty Years of the Slasher",
    footer: "Genre criticism, published monthly.",
    paragraphs: [
      `Fifty years on, the slasher remains the most disreputable corner of horror. The formula is
       grim and almost entirely unchanging: an isolated house, a serial killer with a grudge
       nobody explains until reel four, and a murder every eleven minutes until the credits
       finally arrive.`,
      `What made the early entries land was never the blood. It was the ominous quarter-hour
       before it — the long, shadowy corridor, the dead telephone line, the sense of a
       malevolent presence the camera keeps refusing to show. The best of them are genuinely
       sinister rather than merely gruesome, and the distinction is the whole argument.`,
      `The villain evolved too. The wicked, twisted showman of the eighties gave way to a colder
       and more macabre figure, less a monster than a corrupt idea about small towns. The
       haunted-house thriller borrowed the same trick within a decade. It is dark material,
       handled with far more craft than its reputation admits, and the curse of the genre is
       that almost nobody outside it ever looks closely enough to notice.`,
    ],
  },

  {
    name: "nostalgic_arcade",
    expectedMood: "nostalgic",
    behaviour: BEHAVIOURS.BROWSE,
    // Amber (hue ~35) → energetic +0.15, joyful +0.10 — again outrun by keywords.
    bodyBg: "rgb(247, 240, 226)",
    articleBg: "rgb(200, 150, 80)",
    textColor: "rgb(45, 32, 12)",
    title: "The Arcade on Fifth Street, Twenty Years On",
    description:
      "A vintage cabinet lineup, a Friday tradition, and a reunion in a rented hall — remembering a retro room that closed in 2004.",
    heading: "The Arcade on Fifth Street, Twenty Years On",
    footer: "Local history, filed under things that are gone.",
    paragraphs: [
      `The arcade on Fifth Street closed in 2004, and everyone who grew up there can still
       remember the smell of it: carpet, warm CRT glass, and the vinegar tang of the change
       machine by the door. It was a classic room — a retro cathedral of noise, years before
       anybody thought to call anything retro.`,
      `For a certain childhood this was the entire social calendar. A vintage cabinet lineup, a
       tradition of Friday tokens counted out on the bus, and the familiar unwritten rule that
       you never touched a stranger's machine mid-game. The old regulars still reminisce about
       it on a message board that has now outlived three website redesigns.`,
      `There is a wistful, sentimental quality to that kind of memory, and a throwback reunion
       last spring proved it: two hundred people in a rented hall with four restored cabinets
       and a great deal of bygone slang. Nostalgia is not quite the right word. The machines are
       antique now, practically an heirloom, but the timeless part is the yesteryear feeling of
       a room where nobody could reach you.`,
    ],
  },

  {
    name: "curious_hadal_zone",
    expectedMood: "curious",
    behaviour: BEHAVIOURS.BROWSE,
    // Deep teal (hue ~198, lightness ~0.26) — inside no colourMoodBias band, so
    // this page's mood comes purely from its language.
    bodyBg: "rgb(232, 240, 244)",
    articleBg: "rgb(25, 85, 110)",
    textColor: "rgb(238, 246, 250)",
    title: "What Lives in the Hadal Zone?",
    description:
      "Below six thousand metres the ocean turns into an open question — an unknown habitat, a distribution puzzle, and a phenomenon nobody can yet explain.",
    heading: "What Lives in the Hadal Zone?",
    footer: "Ocean science, written for the surface.",
    paragraphs: [
      `Below six thousand metres the ocean becomes a different planet. The hadal zone — the
       trenches — is the habitat we explore least on this entire world, and very nearly
       everything about it remains an open mystery. How does anything survive at eleven hundred
       atmospheres? Why does one trench produce species found in no other?`,
      `Each expedition seems to uncover a new anomaly. Amphipods with aluminium in their shells.
       Microbial mats that appear to metabolise chemistry nobody had predicted. The science down
       here is genuinely young, which is exactly what makes it fascinating: a field where an
       inquisitive graduate can still discover an entire phylum before lunch.`,
      `The deeper puzzle is distribution. Why do trenches thousands of kilometres apart share an
       ancient lineage? Investigators speculate about a connected deep layer, but nobody can
       investigate it directly for more than a few hours at a time. It is a genuine enigma, a
       riddle inside an unknown volume larger than the mapped surface of the universe we point
       telescopes at, and every dive is a small revelation. The intrigue is that this
       exploration has barely started. It is a phenomenon we can watch and still not explain.`,
    ],
  },

  {
    name: "tense_border_standoff",
    expectedMood: "tense",
    behaviour: BEHAVIOURS.FAST_SCROLL,
    // Near-black (dark +0.30, tense +0.20) plus fast scroll (tense +0.20). The
    // colour prior favours `dark`; the copy has ~22 tense hits and ~0 dark ones.
    bodyBg: "rgb(16, 12, 12)",
    articleBg: "rgb(24, 18, 18)",
    textColor: "rgb(226, 219, 219)",
    title: "BREAKING: Border Standoff Enters Third Day",
    description:
      "Live coverage of an escalating standoff — an emergency alert overnight, an urgent government warning, and four districts told to brace.",
    heading: "BREAKING: Border Standoff Enters Third Day",
    footer: "Rolling coverage. This page updates automatically.",
    paragraphs: [
      `BREAKING — The standoff along the northern corridor entered its third day this morning
       under an urgent government warning, with residents of four districts told to brace for
       further disruption. Officials briefing reporters overnight described the situation as
       volatile and precarious, and declined to say for how long.`,
      `An emergency alert was issued shortly after midnight following an exchange of fire near
       the crossing. There were no confirmed casualties, but the crisis committee convened at
       four in the morning and a senior minister warned that any further attack would put the
       ceasefire beyond recovery. The conflict has already displaced an estimated nine thousand
       people from the eastern districts alone.`,
      `In the border towns the danger is a good deal less abstract. Queues at the fuel depot
       turned to panic on Tuesday; a small riot outside the municipal office was dispersed
       before dawn, and shopkeepers describe an atmosphere of chaos and unrest that no official
       statement has settled. Aid agencies now warn of a humanitarian disaster should the siege
       of the eastern road continue, and the threat of a wider war has not receded. Regional
       markets fell sharply on the alarm.`,
    ],
  },

  {
    name: "uplifting_town_rebuilds",
    expectedMood: "uplifting",
    behaviour: BEHAVIOURS.BROWSE,
    // Green (hue ~120) → calm +0.15, uplifting +0.10.
    bodyBg: "rgb(238, 246, 238)",
    articleBg: "rgb(110, 170, 110)",
    textColor: "rgb(22, 38, 22)",
    title: "After the Water, a High Street Reopens",
    description:
      "Eighteen months of renewal on Marlow High Street: resilience, perseverance, and a small victory that took every trader on the row.",
    heading: "After the Water, a High Street Reopens",
    footer: "Regional desk. Reporting from Marlow.",
    paragraphs: [
      `Eighteen months after the water came through, Marlow High Street reopened on Saturday.
       The renewal is not cosmetic. Every shopfront on the row was gutted to brick, and every
       single one of them chose to come back — a decision the council chair said should inspire
       the whole district, and probably several others besides.`,
      `What the town had, and what money cannot readily buy, was resilience. Volunteers ran a
       kitchen out of the church hall for eleven weeks. A retired plumber trained six people in
       a trade so they could help their neighbours. That kind of perseverance does not photograph
       well, but it is exactly the thing that lets a place overcome a setback of this size.`,
      `There is a stubborn faith in this sort of recovery, and a great deal of gratitude to go
       with it. The mayor's speech was short and unusually positive: he thanked the volunteers,
       said the healing had already happened and the buildings were merely catching up, and
       asked people to encourage the traders who came back first. A new grant will empower the
       traders' association to keep the row tenanted.`,
      `For the traders it is a genuine triumph. Sales are up on the pre-flood year. Two new
       businesses have taken the empty units. The optimism is measurable, and the effect has
       been to transform the town's sense of itself. People here talk about courage without
       embarrassment, and about a small victory that took eighteen months and an unreasonable
       amount of hope. The high street is radiant again on a Saturday. It has been a blessed
       year in the plainest sense of that word, and it is the kind of story that seems to uplift
       everyone who hears it — one that ought to motivate any town facing the same water.`,
    ],
  },

  {
    name: "neutral_recycling_notice",
    expectedMood: "neutral",
    behaviour: BEHAVIOURS.STILL,
    // Teal at hue 180°, saturation ~0.40, lightness ~0.50 — deliberately inside
    // none of colourMoodBias's four hue bands, above its low-saturation cutoff,
    // and between its dark/bright cutoffs, so the colour signal contributes
    // exactly nothing. Combined with BEHAVIOURS.STILL and copy that contains no
    // MOOD_RULES keyword at all, allScores comes out empty and tier-1 returns
    // MOODS.NEUTRAL. Read the header note before touching this page's wording.
    bodyBg: "rgb(77, 179, 179)",
    articleBg: "rgb(77, 179, 179)",
    textColor: "rgb(16, 38, 38)",
    title: "Northfield Kerbside Collection Notice",
    description:
      "Kerbside collection days in the Northfield district from 6 April, with accepted items and replacement bin arrangements.",
    heading: "Northfield Kerbside Collection Notice",
    footer: "Northfield District Council.",
    paragraphs: [
      `Kerbside collection days in the Northfield district change from 6 April. Blue bins will be
       emptied on Tuesday. Green bins will be emptied on alternate Thursdays. Grey bins stay on
       their present day. The revised calendar applies to every street in the district.`,
      `Put bins at the kerb by 6:30am on the correct day. Bins put out after the vehicle has
       passed will not be emptied until the next visit. Lids must close fully. Loose items
       beside a bin will be left where they are.`,
      `Items accepted in the blue bin: paper, card, glass bottles, tins, and rigid plastic
       bottles. Items not accepted: food waste, textiles, garden material, batteries, and
       electrical goods. Batteries and small electrical goods may be taken to the Marlow Lane
       depot on Saturday between 9am and 4pm.`,
      `A replacement bin can be requested through the council website or by telephone.
       Replacement bins arrive within ten days. There is no fee for a first replacement. Missed
       collections should be reported within 48 hours of the stated day.`,
    ],
  },

  {
    name: "sensitive_crisis_support",
    // Not a mood: B1 flags this as sensitive, B2 returns mood "silence" with
    // silent:true, index.js forces volume 0 / isSilent, and background.js must
    // send FADE_TO_SILENCE and never call Feature D at all. The harness asserts
    // exactly that — zero requests to the D stub for this page.
    expectedMood: null,
    expectSilence: true,
    behaviour: BEHAVIOURS.SLOW_READ,
    bodyBg: "rgb(236, 240, 244)",
    articleBg: "rgb(200, 210, 220)",
    textColor: "rgb(24, 32, 40)",
    title: "Crisis Support — You Are Not Alone",
    description:
      "Confidential crisis support lines and resources, available at any hour.",
    heading: "Crisis Support Resources",
    footer: "Confidential support, available 24 hours a day.",
    paragraphs: [
      `If you or someone you know is having thoughts of suicide or self-harm, help is available
       right now. Trained counsellors are ready to listen, confidentially and without judgement,
       whether you are struggling yourself or supporting somebody else through a very difficult
       stretch.`,
      `This page also lists services for domestic violence, for eating disorder recovery, and for
       anyone who simply needs to talk to a person tonight. Reaching out is a sign of strength.
       Every line below is free to call and staffed around the clock, every day of the year.`,
    ],
  },
];
