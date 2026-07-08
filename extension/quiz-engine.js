/* Verse IQ quiz engine — JS port of pipeline/generate_quiz.py plus
 * song-metadata question types (album, producer, features, release year).
 *
 * Deterministic per song (seeded PRNG), same eligibility gates and
 * distractor rules as the Python generator, provenance on every question.
 * Runs in the extension's background service worker.
 */

const MIN_VOTES = 5;
const SUMMARY_MAX_CHARS = 180;
const FRAGMENT_MIN_CHARS = 15;
const FRAGMENT_MAX_CHARS = 250;
const MIN_QUESTIONS = 4;

const ABBREVIATIONS = new Set([
  "pt", "ft", "feat", "st", "mr", "mrs", "ms", "dr", "jr",
  "sr", "vs", "no", "vol", "approx",
]);

// Deterministic PRNG (mulberry32) so a song always builds the same quiz
export function seededRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function plainBody(annotation) {
  return ((annotation.body || {}).plain || "").trim();
}

export function eligible(annotation) {
  if (annotation.state !== "accepted") return false;
  if (!annotation.verified && (annotation.votes_total || 0) < MIN_VOTES) return false;
  const body = plainBody(annotation);
  return body.length >= 40 && body.length <= 1200;
}

export function usableFragment(fragment) {
  fragment = (fragment || "").trim();
  if (fragment.startsWith("[")) return false;
  return fragment.length >= FRAGMENT_MIN_CHARS && fragment.length <= FRAGMENT_MAX_CHARS;
}

function splitSentences(text) {
  const parts = text.split(/(?<=[.!?])\s+/);
  const merged = parts.length ? [parts[0]] : [];
  for (const part of parts.slice(1)) {
    const prev = merged[merged.length - 1];
    const lastWord = prev.replace(/\.$/, "").split(" ").pop().toLowerCase();
    if (prev.endsWith(".") && ABBREVIATIONS.has(lastWord)) {
      merged[merged.length - 1] += ` ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

export function summarize(text) {
  text = text.replace(/\s+/g, " ").trim();
  let out = "";
  for (const sentence of splitSentences(text)) {
    if (out && out.length + sentence.length + 1 > SUMMARY_MAX_CHARS) break;
    out = `${out} ${sentence}`.trim();
    if (out.length >= SUMMARY_MAX_CHARS * 0.6) break;
  }
  if (out.length <= SUMMARY_MAX_CHARS) return out;
  let cut = out.slice(0, SUMMARY_MAX_CHARS - 1);
  if (cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" "));
  return cut.replace(/[,;:—\- ]+$/, "") + "…";
}

function sourceOf(ref, ann, opens = 0) {
  return {
    annotation_id: ann.id,
    referent_id: ref.id,
    annotation_url: ann.url || null,
    verified: ann.verified || false,
    votes_total: ann.votes_total ?? null,
    mixpanel_opens: opens,
  };
}

/* ---- annotation-based questions (ported from generate_quiz.py) ---- */

function buildAnnotationQuestions(song, referents, rng) {
  const pool = [];
  for (const ref of referents) {
    for (const ann of ref.annotations || []) {
      if (eligible(ann)) pool.push([ref, ann]);
    }
  }
  const artist = song.primary_artist.name;
  const questions = [];
  const lyricPool = pool.filter(([ref]) => usableFragment(ref.fragment));

  const correctSummaries = new Set(
    lyricPool.slice(0, 3).map(([, ann]) => summarize(plainBody(ann)))
  );
  const useCount = new Map();

  function pickDistractors(candidates, n = 3) {
    candidates = [...new Set(candidates.filter((c) => !correctSummaries.has(c)))];
    shuffle(candidates, rng);
    candidates.sort((a, b) => (useCount.get(a) || 0) - (useCount.get(b) || 0));
    const picked = candidates.slice(0, n);
    for (const c of picked) useCount.set(c, (useCount.get(c) || 0) + 1);
    return picked;
  }

  for (const [ref, ann] of lyricPool.slice(0, 3)) {
    const distractors = pickDistractors(
      pool.filter(([, a]) => a.id !== ann.id).map(([, a]) => summarize(plainBody(a)))
    );
    if (distractors.length < 3) continue;
    const correct = summarize(plainBody(ann));
    questions.push({
      type: "meaning",
      prompt: `In the line “${ref.fragment}”, what is ${artist} getting at?`,
      correct,
      distractors,
      explanation: correct,
      source: sourceOf(ref, ann),
    });
  }

  if (lyricPool.length >= 4) {
    const [ref, ann] = lyricPool[lyricPool.length - 1];
    const otherFragments = lyricPool
      .filter(([, a]) => a.id !== ann.id)
      .map(([r]) => r.fragment);
    shuffle(otherFragments, rng);
    questions.push({
      type: "reverse",
      prompt: `Deep cut: this explanation is about which lyric? — “${summarize(plainBody(ann))}”`,
      correct: ref.fragment,
      distractors: otherFragments.slice(0, 3),
      explanation: summarize(plainBody(ann)),
      source: sourceOf(ref, ann),
    });
  }

  return questions;
}

/* ---- song-metadata questions (new for the extension) ---- */

const names = (artists) => (artists || []).map((a) => a.name);

function buildMetadataQuestions(song, albumDistractors, rng) {
  const questions = [];
  const title = song.title;
  const producers = names(song.producer_artists);
  const writers = names(song.writer_artists);
  const featured = names(song.featured_artists);
  const primary = song.primary_artist.name;

  // Producer — distractors are people involved with the song but not producers
  if (producers.length) {
    const wrong = [...new Set([...writers, ...featured])]
      .filter((n) => !producers.includes(n) && n !== primary);
    shuffle(wrong, rng);
    if (wrong.length >= 3) {
      questions.push({
        type: "producer",
        prompt: `Who produced “${title}”?`,
        correct: producers[0],
        distractors: wrong.slice(0, 3),
        explanation: `“${title}” was produced by ${producers.join(", ")}.`,
        source: { song_id: song.id, field: "producer_artists" },
      });
    }
  }

  // Album — distractors are the artist's other albums (fetched by background)
  const albumName = (song.album || {}).name;
  if (albumName && albumDistractors.length >= 3) {
    questions.push({
      type: "album",
      prompt: `Which album is “${title}” on?`,
      correct: albumName,
      distractors: shuffle([...albumDistractors], rng).slice(0, 3),
      explanation: `“${title}” appears on ${primary}’s album “${albumName}”.`,
      source: { song_id: song.id, field: "album" },
    });
  }

  // Featured artists — shape depends on how many there are
  if (featured.length >= 3) {
    const notFeatured = [...new Set([...producers, ...writers])]
      .filter((n) => !featured.includes(n) && n !== primary);
    shuffle(notFeatured, rng);
    if (notFeatured.length) {
      const wrongPick = shuffle([...featured], rng).slice(0, 3);
      questions.push({
        type: "features",
        prompt: `Who is NOT a featured artist on “${title}”?`,
        correct: notFeatured[0],
        distractors: wrongPick,
        explanation: `“${title}” features ${featured.join(", ")}.`,
        source: { song_id: song.id, field: "featured_artists" },
      });
    }
  } else if (featured.length >= 1) {
    const notFeatured = [...new Set([...producers, ...writers])]
      .filter((n) => !featured.includes(n) && n !== primary);
    shuffle(notFeatured, rng);
    if (notFeatured.length >= 3) {
      questions.push({
        type: "features",
        prompt: `Which artist is featured on “${title}”?`,
        correct: featured[0],
        distractors: notFeatured.slice(0, 3),
        explanation: `“${title}” features ${featured.join(", ")}.`,
        source: { song_id: song.id, field: "featured_artists" },
      });
    }
  }

  // Release year — distractors are nearby years
  const year = parseInt((song.release_date || "").slice(0, 4), 10);
  if (year) {
    const offsets = shuffle([-3, -2, -1, 1, 2, 3], rng).slice(0, 3);
    questions.push({
      type: "release_year",
      prompt: `What year did “${title}” come out?`,
      correct: String(year),
      distractors: offsets.map((o) => String(year + o)),
      explanation: `“${title}” was released ${song.release_date_for_display || year}.`,
      source: { song_id: song.id, field: "release_date" },
    });
  }

  return questions;
}

/* ---- quiz assembly ---- */

export function buildQuiz(song, referents, albumDistractors = []) {
  const rng = seededRng(song.id);
  const annotationQs = buildAnnotationQuestions(song, referents, rng);
  const metadataQs = buildMetadataQuestions(song, albumDistractors, rng);

  const questions = [...annotationQs];

  // "What is the song about" from the About description
  const description = ((song.description || {}).plain || "").trim();
  if (description.length >= 80 && annotationQs.length >= 3) {
    const wrong = [];
    const seen = new Set();
    for (const q of annotationQs) {
      if (q.type === "meaning" && !seen.has(q.correct)) {
        seen.add(q.correct);
        wrong.push(q.correct);
      }
    }
    // meaning answers describe single lines, not the whole song — plausible but wrong
    if (wrong.length >= 3) {
      questions.push({
        type: "song_meaning",
        prompt: `Big picture: what is “${song.title}” primarily about?`,
        correct: summarize(description),
        distractors: wrong.slice(0, 3),
        explanation: summarize(description),
        source: { song_id: song.id, field: "description" },
      });
    }
  }

  questions.push(...metadataQs);
  if (questions.length < MIN_QUESTIONS) return null;

  // Design: questions ramp easy -> genius-level. Song facts are warmups,
  // line meanings are the middle, the big picture and the deep cut close.
  const DIFFICULTY = {
    release_year: 0, album: 1, features: 2, producer: 3,
    meaning: 4, song_meaning: 5, reverse: 6,
  };
  questions.sort((a, b) => DIFFICULTY[a.type] - DIFFICULTY[b.type]);

  for (const q of questions) {
    const options = [q.correct, ...q.distractors];
    shuffle(options, rng);
    q.options = options;
    q.answer_index = options.indexOf(q.correct);
    delete q.correct;
    delete q.distractors;
  }

  return {
    song_id: song.id,
    song_title: song.title,
    artist: song.primary_artist.name,
    song_url: song.url || null,
    review_status: "unreviewed",
    generated_from: {
      genius: "referents + song metadata (live, in-extension)",
    },
    questions,
  };
}
