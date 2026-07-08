# Verse IQ — Genius lyric trivia minigame (alpha prototype)

A minigame for Genius.com song pages that quizzes visitors on what the song
and its lyrics mean, with questions generated from Genius annotations and
prioritized by Mixpanel engagement data.

Full product & technical plan: [docs/genius-lyric-trivia-minigame-plan.md](docs/genius-lyric-trivia-minigame-plan.md)

## How it fits together

```
Mixpanel (project 446209, event song:open_annotation)
  └─ which annotations each song has + how often readers open them
       │  pipeline/mixpanel_source.py  →  data/mixpanel_top_annotations.json
       ▼
Genius API (api.genius.com: /songs/:id, /referents?song_id=)
  └─ lyric fragments, annotation bodies, votes, verified flags, song "About"
       │  pipeline/genius_client.py
       ▼
pipeline/generate_quiz.py
  └─ quality-gates annotations, builds 5-question quizzes with provenance
       │
       ▼
web/data/quiz-<song_id>.json  →  web/quiz-widget.js on the song page
```

Mixpanel open-counts do double duty: song selection (most-engaged songs get
quizzes first) and difficulty ordering (heavily-opened annotations = easier
questions, deep cuts = harder).

## Run the demo (offline, no credentials)

```bash
python3 pipeline/generate_quiz.py --fixture --song 13560175
cd web && python3 -m http.server 8765
# open http://localhost:8765
```

The fixture uses **real song/annotation IDs from the Mixpanel export but
synthetic lyrics/annotation text** (the dev container cannot reach
genius.com). Every fixture file carries a `_fixture_note` saying so.

## Run against live data

```bash
export GENIUS_ACCESS_TOKEN=...                  # from https://genius.com/api-clients
# — or let the client exchange app credentials for a token itself:
# export GENIUS_CLIENT_ID=... GENIUS_CLIENT_SECRET=...
export MIXPANEL_SERVICE_ACCOUNT=username:secret # Mixpanel service account
export MIXPANEL_PROJECT_ID=446209

python3 pipeline/mixpanel_source.py --from 2026-04-01 --to 2026-07-08
python3 pipeline/generate_quiz.py --top 25
```

No third-party Python dependencies — stdlib only.

## Repo layout

| Path | What it is |
|---|---|
| `docs/genius-lyric-trivia-minigame-plan.md` | Product & technical plan |
| `data/mixpanel_top_annotations.json` | Real export: (song_id, annotation_id, opens), Apr–Jul 2026 |
| `pipeline/mixpanel_source.py` | Rebuilds that export via the Mixpanel Query API |
| `pipeline/genius_client.py` | Genius API client (`--fixture` fallback for offline dev) |
| `pipeline/generate_quiz.py` | Eligibility gate + question builder → `web/data/` |
| `pipeline/fixtures/` | Synthetic Genius payloads for offline demo |
| `web/` | Song-page mock + embeddable quiz widget (vanilla JS/CSS) |

## Analytics

The widget fires the events defined in plan §2 (`quiz_impression`,
`quiz_start`, `question_answered`, `quiz_complete`,
`annotation_opened_from_quiz`) — to the console in the prototype; set
`VerseIQ.mixpanelToken` to also send them to Mixpanel `/track`.

## Known prototype limitations

- `summarize()` is sentence extraction; production swaps in the LLM
  summarize + entailment self-check from plan §4.2.
- Answers ship to the client in the quiz JSON; production grades
  server-side (plan §5.1).
- Fixture content must never ship — regenerate from the live API and put
  generated quizzes through the human review queue (plan §4.4) first.
