/* Verse IQ content script — runs on every genius.com page, activates on song
 * pages. Detects the song ID from the page's app-link meta tag, asks the
 * background worker for a quiz, and mounts the widget as a floating panel.
 *
 * UI implements the "Editorial widget" (1A) direction from the Song Trivia
 * design: square progress cells, 18-second shrinking timer bar (soft — a
 * timeout counts as a miss, never a hard fail), sticker-shadow buttons,
 * shareable result card.
 *
 * Deep links reuse the page's own referent anchors (<a href="/<referent_id>/…">)
 * so "see it in the lyrics" scrolls to and flashes the real annotated line.
 */

(() => {
  const PANEL_ID = "verse-iq-panel";
  const QUESTION_SECONDS = 18;
  const BASE_POINTS = 100;
  const MAX_SPEED_BONUS = 50;
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
    constructor(panel, quiz) {
      this.panel = panel;
      this.el = panel.querySelector(".viq-body");
      this.quiz = quiz;
      this.index = 0;
      this.correctCount = 0;
      this.points = 0;
      this.results = []; // true/false per question, for the progress cells
      this.timerId = null;
      this.questionShownAt = null;
      // Re-shuffle option order per session so answers can't be memorized by position
      this.questions = quiz.questions.map((q) => {
        const order = q.options.map((_, i) => i).sort(() => Math.random() - 0.5);
        return { ...q, options: order.map((i) => q.options[i]), answerIndex: order.indexOf(q.answer_index) };
      });
      track("quiz_impression", { song_id: quiz.song_id });
    }

    renderCells() {
      const cells = this.questions.map((_, i) => {
        let cls = "viq-cell";
        if (i < this.results.length) cls += this.results[i] ? " viq-cell-right" : " viq-cell-wrong";
        else if (i === this.index) cls += " viq-cell-current";
        return `<span class="${cls}"></span>`;
      }).join("");
      this.panel.querySelector(".viq-cells").innerHTML = cells;
    }

    setTimer(running) {
      const fill = this.panel.querySelector(".viq-timer-fill");
      clearTimeout(this.timerId);
      fill.classList.remove("viq-timer-running", "viq-timer-low");
      fill.style.transitionDuration = "0s";
      fill.style.width = "100%";
      if (!running) return;
      // reflow so the reset width applies before the shrink starts
      void fill.offsetWidth;
      fill.style.transitionDuration = `${QUESTION_SECONDS}s`;
      fill.classList.add("viq-timer-running");
      fill.style.width = "0%"; // inline, so it beats the inline 100% reset
      this.timerId = setTimeout(() => this.answer(-1), QUESTION_SECONDS * 1000);
      setTimeout(() => fill.classList.add("viq-timer-low"), (QUESTION_SECONDS - 5) * 1000);
    }

    renderEntry() {
      this.renderCells();
      this.setTimer(false);
      this.el.innerHTML = `
        <div class="viq-card viq-entry">
          <h3>Think you really know “${esc(this.quiz.song_title)}”?</h3>
          <p>${this.questions.length} questions on ${esc(this.quiz.artist)}’s lyrics and the song itself, easy to genius-level. ${QUESTION_SECONDS} seconds each — speed earns bonus points.</p>
          <button class="viq-btn viq-primary">Play Song Trivia</button>
        </div>`;
      this.el.querySelector("button").onclick = () => {
        track("quiz_start", { song_id: this.quiz.song_id });
        this.renderQuestion();
      };
    }

    renderQuestion() {
      const q = this.questions[this.index];
      this.questionShownAt = Date.now();
      this.renderCells();
      this.el.innerHTML = `
        <div class="viq-card">
          <div class="viq-kicker">Question ${this.index + 1} of ${this.questions.length}</div>
          <h3>${esc(q.prompt)}</h3>
          <div class="viq-options">
            ${q.options.map((opt, i) => `<button class="viq-btn viq-option" data-i="${i}">${esc(opt)}</button>`).join("")}
          </div>
        </div>`;
      this.el.querySelectorAll(".viq-option").forEach((btn) => {
        btn.onclick = () => this.answer(parseInt(btn.dataset.i, 10));
      });
      this.setTimer(true);
    }

    answer(chosen) {
      clearTimeout(this.timerId);
      const fill = this.panel.querySelector(".viq-timer-fill");
      fill.style.width = getComputedStyle(fill).width; // freeze the bar
      fill.classList.remove("viq-timer-running");

      const q = this.questions[this.index];
      const timedOut = chosen === -1;
      const correct = !timedOut && chosen === q.answerIndex;
      const elapsed = (Date.now() - this.questionShownAt) / 1000;
      if (correct) {
        this.correctCount += 1;
        this.points += BASE_POINTS +
          Math.round(MAX_SPEED_BONUS * Math.max(0, 1 - elapsed / QUESTION_SECONDS));
      }
      this.results.push(correct);
      this.renderCells();
      track("question_answered", {
        song_id: this.quiz.song_id,
        question_type: q.type,
        annotation_id: q.source.annotation_id ?? null,
        correct,
        timed_out: timedOut,
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
        <div class="viq-verdict">${timedOut ? "Time’s up. Here’s the story:" : correct ? "Correct — you know your bars." : "Not quite. Here’s the story:"}</div>
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
      this.setTimer(false);
      this.renderCells();
      track("quiz_complete", {
        song_id: this.quiz.song_id, score: this.correctCount, total, points: this.points,
      });
      const verdict =
        this.correctCount === total ? "Certified lyrical scholar." :
        this.correctCount >= total - 1 ? "Deep listener." :
        this.correctCount >= Math.ceil(total / 2) ? "You caught the gist." :
        "Time to hit the annotations.";
      this.el.innerHTML = `
        <div class="viq-card viq-result">
          <div class="viq-result-card">
            <div class="viq-score">${this.correctCount}<span>/${total}</span></div>
            <div class="viq-points">${this.points} PTS</div>
            <h3 style="margin-top:10px">${verdict}</h3>
            <div class="viq-result-song">“${esc(this.quiz.song_title)}” — ${esc(this.quiz.artist)}</div>
          </div>
          <button class="viq-btn viq-primary" id="viq-share">Copy my result</button>
          <button class="viq-btn" id="viq-replay">Replay</button>
        </div>`;
      this.el.querySelector("#viq-share").onclick = (e) => {
        const text = `Song Trivia: ${this.correctCount}/${total} (${this.points} pts) on “${this.quiz.song_title}” — ${this.quiz.artist}. Think you know it better? ${this.quiz.song_url || "https://genius.com"}`;
        navigator.clipboard.writeText(text).then(() => {
          e.target.textContent = "Copied!";
          setTimeout(() => { e.target.textContent = "Copy my result"; }, 1500);
        });
        track("quiz_share", { song_id: this.quiz.song_id });
      };
      this.el.querySelector("#viq-replay").onclick = () => {
        this.index = 0; this.correctCount = 0; this.points = 0; this.results = [];
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
        <span class="viq-brand">SONG TRIVIA</span>
        <span class="viq-cells"></span>
        <span class="viq-alpha" title="Generated questions have not been human-reviewed">ALPHA</span>
        <button class="viq-min" title="Minimize">–</button>
      </div>
      <div class="viq-timer"><div class="viq-timer-fill"></div></div>
      <div class="viq-body"><div class="viq-card"><p class="viq-loading">Building your quiz…</p></div></div>`;
    // Attach to <html>, not <body> — Genius's React app hydrates the body and
    // a foreign child there breaks its reconciliation
    document.documentElement.appendChild(panel);
    panel.querySelector(".viq-min").onclick = () => panel.classList.toggle("viq-minimized");
    return panel;
  }

  async function init() {
    const songId = detectSongId();
    if (!songId || songId === currentSongId) return;
    currentSongId = songId;

    const panel = mountPanel();
    const body = panel.querySelector(".viq-body");
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
    new QuizGame(panel, quiz).renderEntry();
  }

  init();
  // Genius is a SPA — watch for in-app navigation to other songs
  setInterval(() => {
    if (detectSongId() !== currentSongId) init();
  }, 1500);
})();
