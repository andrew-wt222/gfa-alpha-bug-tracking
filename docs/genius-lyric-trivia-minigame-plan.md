# Genius Lyric Trivia Minigame — Product & Technical Plan

**Working title:** "Verse IQ" (alternates: "Deep Cuts," "Behind the Bars")
**Surface:** Genius.com song pages (web first, responsive; native apps later)
**Status:** Draft plan for alpha
**Last updated:** 2026-07-07

---

> **Update 2026-07-08 — data sources validated, prototype built.** The
> Mixpanel Genius Production project (446209) tracks `song:open_annotation`
> with both `Song ID` and `annotation_id`, giving the per-song annotation
> inventory and engagement ranking directly (top pair: song 13580520 /
> annotation 39886933, 122k opens Apr–Jul 2026). A working prototype of the
> §4 pipeline and §3 game now lives in this repo — see the README. The
> Genius API half runs on fixtures until a `GENIUS_ACCESS_TOKEN` and network
> egress to genius.com are available in the dev environment.

## 1. Concept

Every Genius song page gets an embedded trivia minigame that quizzes visitors
on the *meaning* of the song and its lyrics. The question bank is generated
from the data Genius already uniquely owns:

- **Annotations** — crowd-sourced and editor/artist-verified explanations of
  specific lyric fragments. These are the source of truth for "what does this
  line mean?"
- **Song bios / "About" sections** — source for song-level meaning questions
  (inspiration, subject matter, backstory).
- **Q&A modules and verified artist commentary** — highest-confidence source
  when available.
- **Song metadata** — producer, samples, writing credits, release context
  (used sparingly as a lighter question type).

The hook: Genius already awards **IQ points** for community contributions.
The minigame extends IQ into a consumption-side loop — you earn IQ by
*understanding* songs, not just annotating them. This gives the game a native
reward system on day one and a flywheel back into annotation (see §6).

## 2. Goals & success metrics

| Goal | Metric (Mixpanel) | Alpha target |
|---|---|---|
| Deepen engagement on song pages | Time on page, scroll depth for players vs. non-players | +20% time on page for players |
| Repeat visitation | 7-day return rate of players vs. matched non-players | +10% relative |
| Game adoption | % of song-page visitors who start a quiz; completion rate | 5% start, 60% complete |
| Annotation flywheel | Post-game clicks into annotations; new annotations from players | Directional |
| Shareability | Share-card generation rate per completed quiz | 3% |

Instrument from day one: `quiz_impression`, `quiz_start`, `question_answered`
(with correctness, question type, time-to-answer), `quiz_complete`,
`quiz_share`, `annotation_opened_from_quiz`.

## 3. Gameplay design

### 3.1 Core loop (MVP)

1. Player hits a song page and sees a compact entry card near the top of the
   lyrics column: *"Think you really know this song? Play the 5-question
   meaning quiz."* Shows friend/global stats when available ("72% of players
   missed Q3").
2. Quiz = **5 multiple-choice questions**, one at a time, 4 options each,
   optional 20-second soft timer (speed bonus, never a hard fail).
3. After each answer: immediate feedback + the **source annotation excerpt**
   with a deep link that scrolls to and highlights the annotated lyric on the
   page. Getting it wrong still teaches you something — that's the Genius
   brand promise.
4. End screen: score, IQ earned, percentile vs. other players of this song,
   share card, and CTAs: *"Replay," "Play another song by [artist],"
   "Disagree with an answer? Improve the annotation."*

### 3.2 Question types (all derived from existing content)

| Type | Prompt shape | Source | Distractors |
|---|---|---|---|
| **Lyric meaning** (core) | "In the line *'…lyric fragment…'*, what is [artist] referring to?" | Top-quality annotation on that fragment | Generated: plausible-but-wrong readings (see §4.3) |
| **Reverse lookup** | "Which lyric is this explanation about?" (shows annotation summary) | Same annotation | 3 other lyric fragments from the same song |
| **Song meaning** | "What inspired this song?" / "What is the song about at its core?" | Song bio / verified Q&A | Generated + facts from other songs by the same artist |
| **Verified vs. fan theory** (later) | "Which of these did [artist] actually confirm?" | Verified-artist annotations | Community annotations on the same line |
| **Reference/sample** (later, lighter) | "This line interpolates which song?" | Annotation + sample metadata | Other songs in the sample graph |

MVP ships the first three types. A quiz mixes types (e.g., 3 lyric-meaning,
1 reverse-lookup, 1 song-meaning).

### 3.3 Scoring & progression

- Base points per correct answer + small speed bonus; convert to a modest,
  capped **Genius IQ award** (e.g., max 10 IQ per song per user, one scoring
  run per song per day) so the game can't be farmed to distort the IQ economy.
- **Streaks**: daily-play streak and per-artist mastery ("You've mastered 8 of
  12 annotated songs on this album — Album Expert badge").
- **Leaderboards**: per-song and per-artist, weekly reset. Global leaderboards
  deferred until anti-cheat is proven.
- Logged-out visitors can play (results in localStorage) but must sign in to
  bank IQ — the game doubles as a registration driver.

## 4. Content pipeline (the hard part)

Annotations are prose written to be read in context; they are not quiz
answers. The pipeline turns them into questions with a quality gate at every
step.

### 4.1 Source selection — which annotations qualify

Score each annotation and only admit those above threshold:

- **Tier 1 (auto-eligible):** verified-artist annotations, editor/staff
  reviewed ("Genius Editor" accepted) annotations.
- **Tier 2 (eligible with checks):** community annotations with net upvotes ≥
  N, contributor IQ above threshold, not flagged, stable (no recent edit
  wars), length within bounds.
- **Excluded:** flagged/disputed annotations, pure transcription notes
  ("*this is a reference to…* [dead link]"), annotations that are mostly
  media embeds, and annotations on songs behind takedown/DMCA state.

A song page qualifies for the game when it has **≥ 6 eligible annotations**
(enough for one quiz without reuse) — this naturally launches the game on the
best-covered, highest-traffic pages first.

### 4.2 Question generation

Offline batch job (not on-demand at page load):

1. **Summarize**: LLM condenses the eligible annotation into a one-sentence
   canonical answer, constrained to only use claims present in the annotation
   (extractive-leaning prompt; the annotation text is the ground truth, the
   model may not add facts).
2. **Draft the question** from a fixed set of templates per question type.
3. **Generate distractors** (§4.3).
4. **Self-check pass**: a second model call verifies (a) the correct answer is
   entailed by the annotation, (b) no distractor is *also* arguably correct,
   (c) the question doesn't leak the answer, (d) tone/safety flags.
5. Store as versioned `QuizQuestion` rows pinned to the **annotation version**
   they were generated from. If the annotation is later edited or deleted,
   the question is auto-suspended and re-queued for regeneration.

### 4.3 Distractors

Wrong answers must be plausible or the game is trivial. Strategy, in order of
preference:

1. **Common misreadings** the annotation itself refutes ("many fans think X,
   but actually Y") — these are gold and frequently present in annotations.
2. LLM-generated plausible-but-wrong interpretations, checked against the
   full annotation set for the song so a "wrong" answer isn't accidentally
   right per a different annotation.
3. Real answers from *other* songs by the same artist (clearly wrong in
   context, thematically plausible).

### 4.4 Human review loop

- Alpha: **100% human review** of generated questions via a lightweight
  internal queue (approve / edit / reject with reason codes). Rejection
  reasons feed prompt iteration.
- In-game **"report question"** control on every question (wrong answer,
  offensive, spoiler, nonsense). Reports above threshold auto-suspend the
  question.
- Post-alpha: sample-based review with auto-publish for Tier 1 sources only,
  keeping full review for Tier 2.

### 4.5 Answer-rate telemetry as a quality signal

If >90% of players get a question right, it's too easy (or leaks the answer);
if <15% and heavily reported, it's probably wrong or ambiguous. Nightly job
flags outliers back into the review queue.

## 5. Technical architecture

### 5.1 Components

- **Quiz Service** (new backend service): owns `QuizQuestion`,
  `QuizSession`, `QuizResult`; serves `GET /songs/:id/quiz` (assembled quiz,
  answers withheld) and `POST /quiz-sessions/:id/answers` (server-side
  grading — correct answers never ship to the client, which is also the
  first line of anti-cheat).
- **Generation pipeline**: scheduled batch workers (queue-driven) that watch
  the annotation firehose/change events, score eligibility, call the LLM
  generation + self-check steps, and write candidates to the review queue.
- **Review tool**: minimal internal CRUD UI over the candidate table.
- **Song-page embed**: a self-contained frontend component (React island)
  lazy-loaded below the fold fold-line; zero impact on lyrics LCP. Deep-link
  integration with the existing annotation highlight/scroll behavior.
- **IQ integration**: server-to-server call into the existing IQ ledger with
  a new event type and per-song/per-day caps enforced in the Quiz Service.

### 5.2 Data model (sketch)

```
QuizQuestion(id, song_id, type, prompt, options[4], correct_index,
             source_annotation_id, source_annotation_version,
             status: candidate|approved|live|suspended|retired,
             review_meta, difficulty_estimate, created_at)

QuizSession(id, song_id, user_id?, anon_id?, question_ids[], started_at)

QuizAnswer(session_id, question_id, chosen_index, correct, ms_to_answer)

QuizResult(session_id, score, iq_awarded, completed_at)
```

### 5.3 Serving & caching

- Assembled quizzes are cacheable per song (randomize question order and
  option order per session server-side). CDN-cache the question payload
  (sans answers); grading is the only strictly dynamic call.
- Question bank per song is small; a nightly rebuild plus event-driven
  suspension on annotation edits keeps freshness without live coupling.

### 5.4 Anti-cheat (proportionate to stakes)

Server-side grading, one IQ-scoring run per song/day, rate limits per
account/IP, and randomized option order. Leaderboard integrity work (device
fingerprinting, anomaly detection) deferred until leaderboards go global.

## 6. Flywheel back into annotation

The game isn't just consumption — it should create contributors:

- End-screen CTA on missed questions: *"Think the annotation's wrong or
  incomplete? Suggest an improvement"* → routes into the existing annotation
  edit/propose flow.
- Songs that *don't* qualify (too few eligible annotations) can show a
  teaser: *"This song doesn't have a quiz yet — annotate 3 more lines to
  unlock it."* Turns coverage gaps into a community quest.
- Question report data doubles as an annotation-quality signal for the
  editorial team.

## 7. Trust, safety & legal considerations

*Informational, not legal advice — route to counsel before launch.*

- **Lyrics licensing:** quiz prompts quote lyric fragments. Confirm that the
  existing publisher/licensing agreements cover display of lyric excerpts in
  an interactive game context (and in **share cards**, which leave the
  licensed page context — share cards may need to show scores only, no lyric
  text, in v1 pending review).
- **UGC exposure:** questions are derived from user-generated annotations.
  Generation + human review is a curation act; have counsel assess Section
  230 posture for derived/edited UGC and keep provenance (source annotation
  ID + version) on every question.
- **DMCA:** questions must auto-suspend when the underlying song/lyrics or
  annotation is taken down; the takedown pipeline needs a hook into the quiz
  bank.
- **COPPA / age gating:** the game must not introduce new data collection
  from under-13 users; explicit-content songs (already flagged in the
  catalog) should exclude explicit lyric fragments from prompts or suppress
  the game per existing content policy.
- **Privacy (GDPR/CCPA):** quiz history is behavioral data tied to accounts —
  include it in existing data-subject access/deletion flows from day one.
- **Artist relations:** verified-artist annotations used in questions should
  be flagged to the artist-relations team before those songs go live in
  alpha; a per-song/per-artist opt-out kill switch is required.

## 8. Rollout plan

**Phase 0 — Prototype (2–3 wks):** Hardcode 10 hand-picked high-traffic,
well-annotated songs. Manual question authoring using the pipeline prompts,
no review tool, internal-only behind a feature flag. Validate fun.

**Phase 1 — Alpha (4–6 wks):** Pipeline + review queue live; ~500 songs
(top-traffic pages meeting the ≥6-eligible-annotation bar); logged-in
Genius community members via opt-in flag; IQ awards on; full Mixpanel
instrumentation; bugs tracked in this repo.

**Phase 2 — Beta:** A/B test on a % of song-page traffic (holdout for the
engagement metrics in §2); open logged-out play; share cards (pending legal
review); per-artist leaderboards.

**Phase 3 — GA + expansion:** All qualifying songs; daily/album/artist quiz
formats ("Daily Verse" — Wordle-style one quiz/day across the catalog is the
strongest retention candidate); native app embed; localization.

## 9. Risks & open questions

1. **Annotation quality variance** is the top product risk — a confidently
   wrong "correct answer" damages Genius's credibility. Mitigation: tiered
   sourcing, 100% alpha review, report loop, provenance pinning.
2. **Subjectivity:** some lyrics have no single meaning. Question templates
   must ask "according to the annotation/artist" style questions where
   interpretation is contested, or skip those lines entirely.
3. **LLM cost:** batch generation over the long tail is the cost driver.
   Gate by page traffic; generate top N thousand songs first, then on
   qualification events.
4. **IQ economy distortion:** keep awards small and capped; monitor IQ
   inflation vs. contributor earnings.
5. **Open:** Does the game live above, beside, or below lyrics? (A/B in
   beta.) Do we allow replays to improve a leaderboard score? (Alpha: replay
   allowed, only first scored run counts.) Multiplayer/challenge-a-friend?
   (Deferred; share card is the v1 social mechanic.)

## 10. Immediate next steps

1. Product sign-off on this plan and the Phase 0 song list (10 songs).
2. Counsel review of §7 (lyric excerpts in game + share cards) in parallel —
   longest lead-time item.
3. Prompt-engineering spike: run the §4.2 pipeline on 3 songs, hand-grade
   output, iterate until ≥80% of generated questions pass review unedited.
4. Design spike: entry card + question UI on the song page (desktop + mobile
   web).
5. Define Mixpanel event schema and dashboards before any code ships.
