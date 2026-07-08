/* Verse IQ content script — runs on every genius.com page, activates on song
 * pages. Detects the song ID from the page's app-link meta tag, asks the
 * background worker for a quiz, and mounts the widget as a floating panel.
 *
 * Deep links reuse the page's own referent anchors (<a href="/<referent_id>/…">)
 * so "see it in the lyrics" scrolls to and flashes the real annotated line.
 */

(() => {
  const PANEL_ID = "verse-iq-panel";
  let currentSongId = null;

  function detectSongId() {
    const meta = document.querySelector('meta[content^="genius://songs/"]');
    if (!meta) return null;
    const m = meta.content.match(/genius:\/\/songs\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function track(event, props) {
    console.log("[verse-iq analytics]", { event: `verse_iq:${event}`, properties: { ...props, ts: Date.now() } });
  }

  function highlightReferent(refId) {
    document.querySelectorAll(".viq-lyric-flash").forEach((el) => el.classList.remove("viq-lyric-flash"));
    const target = document.querySelector(`a[href^="/${refId}/"]`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("viq-lyric-flash");
      track("annotation_opened_from_quiz", { referent_id: refId });
    }
  }

  class QuizGame {
    constructor(body, quiz) {
      this.el = body;
      this.quiz = quiz;
      this.index = 0;
      this.correctCount = 0;
      this.questionShownAt = null;
      // Re-shuffle option order per session so answers can't be memorized by position
      this.questions = quiz.questions.map((q) => {
        const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
        return { ...q, options: order.map((i) => q.options[i]), answerIndex: order.indexOf(q.answer_index) };
      });
      track("quiz_impression", { song_id: quiz.song_id });
    }

    renderEntry() {
      this.el.innerHTML = `
        <div class="viq-card viq-entry">
          <h3>Think you really know “${esc(this.quiz.song_title)}”?</h3>
          <p>${this.questions.length} questions on ${esc(this.quiz.artist)}’s lyrics and the song itself — straight from Genius.</p>
          <button class="viq-btn viq-primary">Play the quiz</button>
        </div>`;
      this.el.querySelector("button").onclick = () => {
        track("quiz_start", { song_id: this.quiz.song_id });
        this.renderQuestion();
      };
    }

    renderQuestion() {
      const q = this.questions[this.index];
      this.questionShownAt = Date.now();
      this.el.innerHTML = `
        <div class="viq-card">
          <div class="viq-kicker">QUESTION ${this.index + 1} OF ${this.questions.length}</div>
          <h3>${esc(q.prompt)}</h3>
          <div class="viq-options">
            ${q.options.map((opt, i) => `<button class="viq-btn viq-option" data-i="${i}">${esc(opt)}</button>`).join("")}
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
      track("question_answered", {
        song_id: this.quiz.song_id,
        question_type: q.type,
        annotation_id: q.source.annotation_id ?? null,
        correct,
        ms_to_answer: Date.now() - this.questionShownAt,
      });

      this.el.querySelectorAll(".viq-option").forEach((btn, i) => {
        btn.disabled = true;
        if (i === q.answerIndex) btn.classList.add("viq-correct");
        else if (i === chosen) btn.classList.add("viq-wrong");
      });

      const card = this.el.querySelector(".viq-card");
      const feedback = document.createElement("div");
      feedback.className = "viq-feedback";
      feedback.innerHTML = `
        <div class="viq-verdict">${correct ? "Correct — you know your bars." : "Not quite. Here’s the story:"}</div>
        <blockquote>${esc(q.explanation)}</blockquote>
        ${q.source.annotation_id
          ? `<div class="viq-source">From annotation ${q.source.annotation_id}${q.source.verified ? " · ✓ artist verified" : ""}${q.source.votes_total != null ? ` · ▲ ${q.source.votes_total}` : ""}
               ${q.source.referent_id ? `· <a href="#" class="viq-jump" data-ref="${q.source.referent_id}">see it in the lyrics</a>` : ""}</div>`
          : `<div class="viq-source">From the song’s Genius metadata</div>`}
        <button class="viq-btn viq-primary">${this.index + 1 < this.questions.length ? "Next question" : "See my score"}</button>`;
      card.appendChild(feedback);

      const jump = feedback.querySelector(".viq-jump");
      if (jump) jump.onclick = (e) => { e.preventDefault(); highlightReferent(jump.dataset.ref); };
      feedback.querySelector(".viq-primary").onclick = () => {
        this.index += 1;
        this.index < this.questions.length ? this.renderQuestion() : this.renderResult();
      };
    }

    renderResult() {
      const total = this.questions.length;
      const iq = this.correctCount * 2;
      track("quiz_complete", { song_id: this.quiz.song_id, score: this.correctCount, total, iq_awarded: iq });
      const verdict =
        this.correctCount === total ? "Certified lyrical scholar." :
        this.correctCount >= total - 1 ? "Deep listener." :
        this.correctCount >= Math.ceil(total / 2) ? "You caught the gist." :
        "Time to hit the annotations.";
      this.el.innerHTML = `
        <div class="viq-card viq-result">
          <div class="viq-score">${this.correctCount}/${total}</div>
          <h3>${verdict}</h3>
          <p>+${iq} IQ (prototype — not banked)</p>
          <button class="viq-btn viq-primary" id="viq-replay">Replay</button>
        </div>`;
      this.el.querySelector("#viq-replay").onclick = () => {
        this.index = 0; this.correctCount = 0;
        track("quiz_start", { song_id: this.quiz.song_id, replay: true });
        this.renderQuestion();
      };
    }
  }

  function mountPanel() {
    document.getElementById(PANEL_ID)?.remove();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="viq-header">
        <span class="viq-brand">VERSE IQ</span>
        <span class="viq-alpha" title="Generated questions have not been human-reviewed">ALPHA · UNREVIEWED</span>
        <button class="viq-min" title="Minimize">–</button>
      </div>
      <div class="viq-body"><div class="viq-card"><p class="viq-loading">Building your quiz…</p></div></div>`;
    // Attach to <html>, not <body> — Genius's React app hydrates the body and
    // a foreign child there breaks its reconciliation
    document.documentElement.appendChild(panel);
    panel.querySelector(".viq-min").onclick = () => panel.classList.toggle("viq-minimized");
    return panel.querySelector(".viq-body");
  }

  async function init() {
    const songId = detectSongId();
    if (!songId || songId === currentSongId) return;
    currentSongId = songId;

    const body = mountPanel();
    const quiz = await chrome.runtime.sendMessage({ type: "GET_QUIZ", songId });

    if (quiz?.error === "no_token" || quiz?.error === "bad_token") {
      body.innerHTML = `
        <div class="viq-card">
          <p>${quiz.error === "no_token" ? "Set your Genius API token to generate quizzes." : "Your Genius API token was rejected — update it."}</p>
          <button class="viq-btn viq-primary" id="viq-opts">Open settings</button>
        </div>`;
      body.querySelector("#viq-opts").onclick = () =>
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
      return;
    }
    if (!quiz || quiz.error) {
      document.getElementById(PANEL_ID)?.remove();
      currentSongId = null; // allow retry on SPA re-navigation
      return;
    }
    new QuizGame(body, quiz).renderEntry();
  }

  init();
  // Genius is a SPA — watch for in-app navigation to other songs
  setInterval(() => {
    if (detectSongId() !== currentSongId) init();
  }, 1500);
})();
