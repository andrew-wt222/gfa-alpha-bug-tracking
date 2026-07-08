/* Verse IQ — lyric trivia widget for Genius song pages (prototype).
 *
 * Embeds into a song page, loads web/data/quiz-<songId>.json (built by
 * pipeline/generate_quiz.py), runs a 5-question quiz, and fires the
 * analytics events from the plan (quiz_impression, quiz_start,
 * question_answered, quiz_complete). Analytics go to console in the
 * prototype; set VerseIQ.mixpanelToken to also send them to Mixpanel's
 * /track endpoint.
 */

const VerseIQ = {
  mixpanelToken: null, // set to a Mixpanel project token to send real events

  track(event, props) {
    const payload = { event: `verse_iq:${event}`, properties: { ...props, ts: Date.now() } };
    console.log("[verse-iq analytics]", payload);
    if (this.mixpanelToken) {
      const data = btoa(JSON.stringify({ ...payload, properties: { ...payload.properties, token: this.mixpanelToken } }));
      fetch(`https://api.mixpanel.com/track/?data=${encodeURIComponent(data)}`).catch(() => {});
    }
  },

  async mount(container, songId) {
    const res = await fetch(`data/quiz-${songId}.json`);
    if (!res.ok) { container.remove(); return; }
    const quiz = await res.json();
    new QuizGame(container, quiz).renderEntry();
  },
};

class QuizGame {
  constructor(container, quiz) {
    this.el = container;
    this.quiz = quiz;
    this.index = 0;
    this.correctCount = 0;
    this.questionShownAt = null;
    // Re-shuffle option order per session so answers can't be memorized by position
    this.questions = quiz.questions.map((q) => {
      const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
      return { ...q, options: order.map((i) => q.options[i]), answerIndex: order.indexOf(q.answer_index) };
    });
    VerseIQ.track("quiz_impression", { song_id: quiz.song_id });
  }

  renderEntry() {
    this.el.innerHTML = `
      <div class="viq-card viq-entry">
        <div class="viq-kicker">VERSE IQ</div>
        <h3>Think you really know “${this.quiz.song_title}”?</h3>
        <p>${this.questions.length} questions on what ${this.quiz.artist}’s lyrics actually mean — straight from the annotations.</p>
        <button class="viq-btn viq-primary">Play the quiz</button>
      </div>`;
    this.el.querySelector("button").onclick = () => {
      VerseIQ.track("quiz_start", { song_id: this.quiz.song_id });
      this.renderQuestion();
    };
  }

  renderQuestion() {
    const q = this.questions[this.index];
    this.questionShownAt = Date.now();
    this.el.innerHTML = `
      <div class="viq-card">
        <div class="viq-kicker">VERSE IQ · QUESTION ${this.index + 1} OF ${this.questions.length}</div>
        <h3>${q.prompt}</h3>
        <div class="viq-options">
          ${q.options.map((opt, i) => `<button class="viq-btn viq-option" data-i="${i}">${opt}</button>`).join("")}
        </div>
      </div>`;
    this.el.querySelectorAll(".viq-option").forEach((btn) => {
      btn.onclick = () => this.answer(parseInt(btn.dataset.i, 10));
    });
  }

  answer(chosen) {
    const q = this.questions[this.index];
    const correct = chosen === q.answerIndex;
    if (correct) this.correctCount += 1;
    VerseIQ.track("question_answered", {
      song_id: this.quiz.song_id,
      question_type: q.type,
      annotation_id: q.source.annotation_id ?? null,
      correct,
      ms_to_answer: Date.now() - this.questionShownAt,
    });

    const buttons = this.el.querySelectorAll(".viq-option");
    buttons.forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.answerIndex) btn.classList.add("viq-correct");
      else if (i === chosen) btn.classList.add("viq-wrong");
    });

    const card = this.el.querySelector(".viq-card");
    const feedback = document.createElement("div");
    feedback.className = "viq-feedback";
    feedback.innerHTML = `
      <div class="viq-verdict">${correct ? "Correct — you know your bars." : "Not quite. Here’s the meaning:"}</div>
      <blockquote>${q.explanation}</blockquote>
      ${q.source.annotation_id
        ? `<div class="viq-source">From annotation ${q.source.annotation_id}${q.source.verified ? " · ✓ artist verified" : ""}${q.source.votes_total != null ? ` · ▲ ${q.source.votes_total}` : ""}
             ${q.source.referent_id ? `· <a href="#ref-${q.source.referent_id}" class="viq-jump" data-ref="${q.source.referent_id}">see it in the lyrics</a>` : ""}</div>`
        : `<div class="viq-source">From the song’s About section</div>`}
      <button class="viq-btn viq-primary">${this.index + 1 < this.questions.length ? "Next question" : "See my score"}</button>`;
    card.appendChild(feedback);

    const jump = feedback.querySelector(".viq-jump");
    if (jump) jump.onclick = () => highlightReferent(jump.dataset.ref);
    feedback.querySelector(".viq-primary").onclick = () => {
      this.index += 1;
      this.index < this.questions.length ? this.renderQuestion() : this.renderResult();
    };
  }

  renderResult() {
    const total = this.questions.length;
    const iq = this.correctCount * 2; // capped award, mirrors plan §3.3
    VerseIQ.track("quiz_complete", {
      song_id: this.quiz.song_id, score: this.correctCount, total, iq_awarded: iq,
    });
    const verdict =
      this.correctCount === total ? "Certified lyrical scholar." :
      this.correctCount >= total - 1 ? "Deep listener." :
      this.correctCount >= Math.ceil(total / 2) ? "You caught the gist." :
      "Time to hit the annotations.";
    this.el.innerHTML = `
      <div class="viq-card viq-result">
        <div class="viq-kicker">VERSE IQ · RESULT</div>
        <div class="viq-score">${this.correctCount}/${total}</div>
        <h3>${verdict}</h3>
        <p>+${iq} IQ${iq ? " banked to your Genius account (sign in to keep it)" : ""}</p>
        <div class="viq-actions">
          <button class="viq-btn viq-primary" id="viq-replay">Replay</button>
          <button class="viq-btn" id="viq-improve">Disagree with an answer? Improve the annotation</button>
        </div>
      </div>`;
    this.el.querySelector("#viq-replay").onclick = () => {
      this.index = 0; this.correctCount = 0;
      VerseIQ.track("quiz_start", { song_id: this.quiz.song_id, replay: true });
      this.renderQuestion();
    };
    this.el.querySelector("#viq-improve").onclick = () => {
      VerseIQ.track("annotation_improve_cta", { song_id: this.quiz.song_id });
      alert("Prototype: this routes into the existing annotation edit/propose flow.");
    };
  }
}

function highlightReferent(refId) {
  document.querySelectorAll(".lyric-annotated").forEach((el) => el.classList.remove("lyric-flash"));
  const target = document.getElementById(`ref-${refId}`);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("lyric-flash");
    VerseIQ.track("annotation_opened_from_quiz", { referent_id: parseInt(refId, 10) });
  }
}
