# C-16 — the confirmatory models, exactly as pre-registered.
#
#   Rscript analysis/s4/models.R analysis/out/s4_tidy.json
#
# This is what the paper reports. analysis/s4/simulate_and_check.py implements
# the same specification in Python and is what proves the design is
# recoverable before any data exists — it is a check, not the analysis, because
# statsmodels' MixedLM takes one grouping factor and the pre-registered models
# have two (participant and page). Where the two disagree on real data, this
# file wins and the disagreement is worth investigating before either is
# reported.
#
# Every formula below is reproduced verbatim in the pre-registration and in the
# paper's appendix. Changing one after data collection makes it exploratory;
# say so in the text rather than editing quietly.

suppressPackageStartupMessages({
  library(jsonlite); library(lme4); library(lmerTest); library(ordinal); library(emmeans)
})

args <- commandArgs(trailingOnly = TRUE)
path <- if (length(args) > 0) args[1] else "analysis/out/s4_tidy.json"
raw <- fromJSON(path, simplifyDataFrame = TRUE)

if (isTRUE(raw$simulated)) {
  message("NOTE: this file is SIMULATED data (", raw$n_participants, " participants). ",
          "Results below are a pipeline check, not findings.")
}

responses <- as.data.frame(raw$responses)
blocks    <- as.data.frame(raw$blocks)

responses$participant <- factor(responses$participant)
responses$page        <- factor(responses$page)
responses$condition   <- relevel(factor(responses$condition), ref = "SHUFFLED")
blocks$participant    <- factor(blocks$participant)
blocks$condition      <- relevel(factor(blocks$condition), ref = "PLAYLIST")

# ── H1, H2 — fit ratings ──────────────────────────────────────────────────
# Ordinal outcome, so a cumulative-link mixed model rather than a linear one.
# Averaging Likert responses per participant and running a t-test on the means
# is the thing the plan explicitly forbids: page-level variance is a
# substantial part of the story here (some pages are simply harder to score
# music for) and collapsing it discards exactly that.
#
# SILENCE contributes no fit rating — there was no music to suit the page — so
# it drops out of this model by construction, not by exclusion.
fit_data <- subset(responses, !is.na(fit) & condition != "SILENCE")
fit_data$fit <- ordered(fit_data$fit, levels = 1:7)
fit_data$condition <- droplevels(fit_data$condition)

m_fit <- clmm(fit ~ condition + (1 | participant) + (1 | page), data = fit_data)
cat("\n=== H1/H2  fit ~ condition + (1|participant) + (1|page) ===\n")
print(summary(m_fit))
print(emmeans(m_fit, pairwise ~ condition, adjust = "none")$contrasts)

# Fit controlling for liking. §10 flags that a fit rating may really be
# measuring "I liked this music"; the honest response is to report both.
if ("liking" %in% names(fit_data)) {
  m_fit_liking <- clmm(fit ~ condition + scale(liking) + (1 | participant) + (1 | page),
                       data = subset(fit_data, !is.na(liking)))
  cat("\n=== H1/H2 controlling for liking ===\n")
  print(summary(m_fit_liking))
}

# ── H3 — comprehension equivalence ────────────────────────────────────────
# An equivalence claim, not a null-hypothesis one. A non-significant t-test is
# not evidence of no harm; TOST against ±0.5 questions is.
m_comp <- lmer(comprehension ~ condition + (1 | participant) + (1 | page),
               data = responses)
cat("\n=== H3  comprehension ~ condition + (1|participant) + (1|page) ===\n")
print(summary(m_comp))

per_p <- aggregate(comprehension ~ participant + condition, responses, mean)
wide  <- reshape(per_p, idvar = "participant", timevar = "condition", direction = "wide")
d     <- wide$comprehension.ADAPTIVE - wide$comprehension.SILENCE
d     <- d[!is.na(d)]
bound <- 0.5
se    <- sd(d) / sqrt(length(d))
t_lo  <- (mean(d) + bound) / se
t_hi  <- (mean(d) - bound) / se
p_tost <- max(pt(t_lo, length(d) - 1, lower.tail = FALSE),
              pt(t_hi, length(d) - 1, lower.tail = TRUE))
ci90 <- mean(d) + c(-1, 1) * qt(0.95, length(d) - 1) * se
cat("\n--- H3 TOST, bounds +/-", bound, "questions ---\n")
cat("n =", length(d), " mean difference =", round(mean(d), 4), "\n")
cat("90% CI [", round(ci90[1], 4), ",", round(ci90[2], 4), "]\n")
cat("p_TOST =", signif(p_tost, 4),
    if (p_tost < 0.05) " -> equivalent\n" else " -> equivalence NOT shown\n")

# ── H4 — workload ─────────────────────────────────────────────────────────
m_tlx <- lmer(tlx ~ condition + (1 | participant), data = blocks)
cat("\n=== H4  tlx ~ condition + (1|participant) ===\n")
print(summary(m_tlx))
print(emmeans(m_tlx, pairwise ~ condition, adjust = "none")$contrasts)

# ── Counts: skips, mutes, turn-it-off presses ─────────────────────────────
# Poisson first, negative binomial when overdispersed. The exposure offset
# matters: blocks are not all the same length once a session runs late.
if ("turnoff_presses" %in% names(blocks)) {
  m_off <- glmer(turnoff_presses ~ condition + (1 | participant),
                 data = blocks, family = poisson)
  disp <- sum(residuals(m_off, type = "pearson")^2) / df.residual(m_off)
  cat("\n=== turn-it-off presses ~ condition + (1|participant), Poisson ===\n")
  cat("dispersion =", round(disp, 3), if (disp > 1.5) " -> refit as negative binomial\n" else "\n")
  print(summary(m_off))
  if (disp > 1.5) {
    m_off_nb <- glmer.nb(turnoff_presses ~ condition + (1 | participant), data = blocks)
    print(summary(m_off_nb))
  }
}

# ── Holm within the confirmatory family ───────────────────────────────────
# One family, four hypotheses, corrected together. Exploratory analyses are
# reported separately and labelled, uncorrected.
cat("\n=== Confirmatory family, Holm-corrected ===\n")
cat("Assemble the four p-values (H1, H2 from the clmm contrasts; H3 = p_TOST;\n")
cat("H4 from the tlx contrast) and apply p.adjust(p, method = 'holm').\n")
cat("They are not auto-collected here on purpose: reading each one off its own\n")
cat("model output is a deliberate checkpoint against correcting the wrong four.\n")
