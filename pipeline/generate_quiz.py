"""Build per-song quiz JSON from Genius annotations + Mixpanel engagement.

Data flow:
  data/mixpanel_top_annotations.json   which annotations each song has, ranked
    (from pipeline/mixpanel_source.py)   by how often readers open them
  Genius API (or fixtures)             fragment text, annotation bodies, song
    (pipeline/genius_client.py)          metadata, "About" description

Question types (deterministic — no LLM needed for the prototype):
  meaning        "In the line '<fragment>', what is the artist getting at?"
                 correct = that fragment's annotation; distractors = other
                 annotations from the same song (right style, wrong line)
  reverse        "Which lyric is this explanation about?" — options are four
                 fragments from the song
  song_meaning   "What is this song about?" — correct = song description;
                 distractors = other songs' descriptions or shuffled claims

Mixpanel open-counts order the questions easy -> hard: annotations everyone
opens are familiar, rarely-opened ones are deep cuts.

Usage:
  python3 pipeline/generate_quiz.py --fixture              # offline demo
  python3 pipeline/generate_quiz.py --song 13560175        # live API
  python3 pipeline/generate_quiz.py --top 25               # top 25 songs
"""

import argparse
import json
import pathlib
import random
import re

from genius_client import GeniusClient

ROOT = pathlib.Path(__file__).parent.parent
MIXPANEL_DATA = ROOT / "data" / "mixpanel_top_annotations.json"
OUT_DIR = ROOT / "web" / "data"

MIN_ELIGIBLE_ANNOTATIONS = 6  # song qualifies for a quiz at all
MIN_VOTES = 5                 # community annotation quality floor
QUESTIONS_PER_QUIZ = 5
SUMMARY_MAX_CHARS = 180
FRAGMENT_MIN_CHARS = 15       # live data: "[Intro]"-style section headers slip in
FRAGMENT_MAX_CHARS = 250      # live data: some referents span whole verses

# Sentence splitting that survives real annotation prose: don't split after
# common abbreviations ("heart pt. 6", "Little St. James", "Dr. Dre").
_ABBREVIATIONS = {"pt", "ft", "feat", "st", "mr", "mrs", "ms", "dr", "jr",
                  "sr", "vs", "no", "vol", "approx"}


def split_sentences(text):
    parts = re.split(r"(?<=[.!?])\s+", text)
    merged = [parts[0]] if parts else []
    for part in parts[1:]:
        last_word = merged[-1].rstrip(".").rsplit(" ", 1)[-1].lower()
        if merged[-1].endswith(".") and last_word in _ABBREVIATIONS:
            merged[-1] += f" {part}"
        else:
            merged.append(part)
    return merged


def usable_fragment(fragment):
    """Reject section headers ('[Intro]', '[Bridge] ...') and extreme lengths
    so lyric fragments work as quiz prompts/options."""
    fragment = fragment.strip()
    if fragment.startswith("["):
        return False
    return FRAGMENT_MIN_CHARS <= len(fragment) <= FRAGMENT_MAX_CHARS


def load_mixpanel_ranking():
    """{song_id: [(annotation_id, opens), ...] ranked by opens desc}."""
    doc = json.loads(MIXPANEL_DATA.read_text())
    ranking = {}
    for song_id, annotation_id, opens in doc["rows"]:
        ranking.setdefault(song_id, []).append((annotation_id, opens))
    return ranking


def eligible(annotation):
    """Quality gate per the plan: accepted + voted (or verified), sane length."""
    if annotation.get("state") != "accepted":
        return False
    if not annotation.get("verified") and annotation.get("votes_total", 0) < MIN_VOTES:
        return False
    body = plain_body(annotation)
    return 40 <= len(body) <= 1200


def plain_body(annotation):
    return (annotation.get("body") or {}).get("plain", "").strip()


def summarize(text):
    """First sentence(s) of an annotation, capped — quiz answers must be short.
    The production pipeline replaces this with an LLM summarize + entailment
    check (plan §4.2); sentence extraction is enough to prove the format."""
    text = re.sub(r"\s+", " ", text).strip()
    out = ""
    for sentence in split_sentences(text):
        if out and len(out) + len(sentence) + 1 > SUMMARY_MAX_CHARS:
            break
        out = f"{out} {sentence}".strip()
        if len(out) >= SUMMARY_MAX_CHARS * 0.6:
            break
    if len(out) <= SUMMARY_MAX_CHARS:
        return out
    # Truncate at a word boundary, never mid-word
    cut = out[: SUMMARY_MAX_CHARS - 1]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(",;:—- ") + "…"


def build_questions(song, referents, opens_by_annotation, rng):
    """Assemble one quiz's questions with full provenance on each."""
    pool = []  # (referent, annotation, opens)
    for ref in referents:
        for ann in ref.get("annotations", []):
            if eligible(ann):
                pool.append((ref, ann, opens_by_annotation.get(ann["id"], 0)))
    if len(pool) < MIN_ELIGIBLE_ANNOTATIONS:
        return None

    pool.sort(key=lambda t: -t[2])  # most-opened first = easiest first
    artist = song["primary_artist"]["name"]
    questions = []

    # Fragments must read as lyrics for prompts/options; live referents include
    # section headers and whole-verse spans that don't.
    lyric_pool = [t for t in pool if usable_fragment(t[0]["fragment"])]

    # An option that is the correct answer to one question must never appear
    # as a distractor in another — a player would be told it's wrong there
    # and right later. Small pools force some distractor reuse; spread it.
    correct_summaries = {summarize(plain_body(ann)) for _, ann, _ in lyric_pool[:3]}
    distractor_variety = len(
        {summarize(plain_body(ann)) for _, ann, _ in pool} - correct_summaries
    )
    # 12 distractor slots; ≥5 distinct sources keeps any single wrong answer
    # from appearing more than ~2-3 times in one quiz (thin pools showed the
    # same distractor 4x on live data)
    if distractor_variety < 5:
        return None
    use_count = {}

    def pick_distractors(candidates, n=3):
        """Least-reused first; never an option that is a correct answer."""
        candidates = list(dict.fromkeys(
            c for c in candidates if c not in correct_summaries
        ))
        rng.shuffle(candidates)  # deterministic via seeded rng
        candidates.sort(key=lambda c: use_count.get(c, 0))
        picked = candidates[:n]
        for c in picked:
            use_count[c] = use_count.get(c, 0) + 1
        return picked

    # 3 "meaning" questions on the most-engaged fragments
    for ref, ann, opens in lyric_pool[:3]:
        distractors = pick_distractors([
            summarize(plain_body(other_ann))
            for other_ref, other_ann, _ in pool
            if other_ann["id"] != ann["id"]
        ])
        correct = summarize(plain_body(ann))
        questions.append({
            "type": "meaning",
            "prompt": f"In the line “{ref['fragment']}”, what is {artist} getting at?",
            "correct": correct,
            "distractors": distractors,
            "explanation": correct,
            "source": {
                "annotation_id": ann["id"],
                "referent_id": ref["id"],
                "annotation_url": ann.get("url"),
                "verified": ann.get("verified", False),
                "votes_total": ann.get("votes_total"),
                "mixpanel_opens": opens,
            },
        })

    # 1 "reverse lookup" on a deep cut (least-opened usable fragment)
    if len(lyric_pool) >= 4:
        ref, ann, opens = lyric_pool[-1]
        other_fragments = [
            r["fragment"] for r, a, _ in lyric_pool if a["id"] != ann["id"]
        ]
        rng.shuffle(other_fragments)
        questions.append({
            "type": "reverse",
            "prompt": f"Deep cut: this explanation is about which lyric? — “{summarize(plain_body(ann))}”",
            "correct": ref["fragment"],
            "distractors": other_fragments[:3],
            "explanation": summarize(plain_body(ann)),
            "source": {
                "annotation_id": ann["id"],
                "referent_id": ref["id"],
                "annotation_url": ann.get("url"),
                "verified": ann.get("verified", False),
                "votes_total": ann.get("votes_total"),
                "mixpanel_opens": opens,
            },
        })

    # 1 "song meaning" from the About description when present
    description = (song.get("description") or {}).get("plain", "").strip()
    if len(description) >= 80:
        wrong = pick_distractors([
            summarize(plain_body(a))
            for _, a, _ in pool[3:]
        ])
        questions.append({
            "type": "song_meaning",
            "prompt": f"Big picture: what is “{song['title']}” about?",
            "correct": summarize(description),
            "distractors": wrong,
            "explanation": summarize(description),
            "source": {"song_id": song["id"], "field": "description"},
        })

    # A thin quiz isn't worth shipping; live data sometimes leaves too few
    # usable fragments even when annotations pass the eligibility gate.
    if len(questions) < 4:
        return None
    return questions[:QUESTIONS_PER_QUIZ]


def generate_for_song(client, song_id, ranking):
    song = client.song(song_id)
    referents = client.referents(song_id)
    opens_by_annotation = dict(ranking.get(song_id, []))
    rng = random.Random(song_id)  # reproducible builds per song

    questions = build_questions(song, referents, opens_by_annotation, rng)
    if not questions:
        print(f"  song {song_id}: not enough eligible annotations / distractor variety, skipped")
        return None

    # Shuffle option order once at build time; the widget re-shuffles per session
    for q in questions:
        options = [q["correct"], *q["distractors"]]
        rng.shuffle(options)
        q["options"] = options
        q["answer_index"] = options.index(q["correct"])
        del q["correct"], q["distractors"]

    quiz = {
        "song_id": song["id"],
        "song_title": song["title"],
        "artist": song["primary_artist"]["name"],
        "song_url": song.get("url"),
        # Plan §4.4: 100% human review before anything ships in alpha
        "review_status": "unreviewed",
        # Lets the demo page distinguish synthetic fixture content from live data
        "fixture": client.use_fixtures,
        "generated_from": {
            "genius": "referents + song description",
            "mixpanel": "song:open_annotation opens (project 446209)",
        },
        "questions": questions,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"quiz-{song_id}.json"
    out_path.write_text(json.dumps(quiz, indent=2, ensure_ascii=False))

    # The Genius API doesn't serve full lyrics; the demo page renders the
    # annotated fragments instead, keyed by referent id for quiz deep links.
    fragments = {
        "song_id": song["id"],
        "note": "Annotated fragments only — the Genius API does not serve full lyrics.",
        "fragments": [
            {"referent_id": ref["id"], "text": ref["fragment"]}
            for ref in referents
            if ref.get("fragment", "").strip()
        ],
    }
    (OUT_DIR / f"fragments-{song_id}.json").write_text(
        json.dumps(fragments, indent=2, ensure_ascii=False)
    )
    print(f"  song {song_id} ({song['title']}): {len(questions)} questions -> {out_path.relative_to(ROOT)}")
    return quiz


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", action="store_true",
                        help="use pipeline/fixtures instead of the live Genius API")
    parser.add_argument("--song", type=int, help="generate for one song id")
    parser.add_argument("--top", type=int, default=10,
                        help="generate for the top N songs by annotation engagement")
    args = parser.parse_args()

    ranking = load_mixpanel_ranking()
    client = GeniusClient(use_fixtures=args.fixture)

    if args.song:
        song_ids = [args.song]
    else:
        by_engagement = sorted(
            ranking.items(), key=lambda kv: -sum(opens for _, opens in kv[1])
        )
        song_ids = [song_id for song_id, anns in by_engagement
                    if len(anns) >= MIN_ELIGIBLE_ANNOTATIONS][: args.top]

    print(f"Generating quizzes for {len(song_ids)} song(s)...")
    built = 0
    for song_id in song_ids:
        try:
            if generate_for_song(client, song_id, ranking):
                built += 1
        except FileNotFoundError as e:
            print(f"  song {song_id}: {e}")
    print(f"Done: {built} quiz(zes) written to {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
