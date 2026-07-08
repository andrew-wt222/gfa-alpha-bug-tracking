/* Verse IQ background service worker.
 *
 * Owns all Genius API traffic (host_permissions cover api.genius.com; the
 * content script has no cross-origin rights). The access token lives in
 * chrome.storage.sync, pasted once via the options page — never bundled
 * with the extension.
 */

import { buildQuiz } from "./quiz-engine.js";

const API_BASE = "https://api.genius.com";
const MAX_RETRIES = 3;
const quizCache = new Map(); // songId -> quiz, per service-worker lifetime

async function getToken() {
  const { geniusToken } = await chrome.storage.sync.get("geniusToken");
  return geniusToken || null;
}

async function apiGet(path, params, token) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null) url.searchParams.set(k, v);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return (await res.json()).response;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Genius API ${res.status} for ${path}`);
    }
    const retryAfter = parseFloat(res.headers.get("Retry-After"));
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function fetchReferents(songId, token) {
  const referents = [];
  for (let page = 1; ; page++) {
    const batch = (
      await apiGet("/referents", {
        song_id: songId, text_format: "plain", per_page: 50, page,
      }, token)
    ).referents;
    referents.push(...batch);
    if (batch.length < 50) return referents;
  }
}

// The artist's other album names, for album-question distractors. The songs
// list endpoint doesn't include albums, so sample a few popular songs.
async function fetchAlbumDistractors(artistId, excludeAlbum, token) {
  try {
    const { songs } = await apiGet(`/artists/${artistId}/songs`, {
      sort: "popularity", per_page: 12,
    }, token);
    const albums = new Set();
    for (const s of songs.slice(0, 8)) {
      if (albums.size >= 3) break;
      const { song } = await apiGet(`/songs/${s.id}`, { text_format: "plain" }, token);
      const name = (song.album || {}).name;
      if (name && name !== excludeAlbum) albums.add(name);
    }
    return [...albums];
  } catch {
    return []; // album question is optional; never fail the quiz over it
  }
}

// Album track list for album mode. Undocumented but working endpoint;
// album mode simply doesn't render if it ever goes away.
async function fetchAlbumTracks(albumId, token) {
  try {
    const { tracks } = await apiGet(`/albums/${albumId}/tracks`, { per_page: 50 }, token);
    return tracks
      .filter((t) => t.song)
      .map((t) => ({
        number: t.number,
        song_id: t.song.id,
        title: t.song.title,
        url: t.song.url,
      }));
  } catch {
    return [];
  }
}

async function getQuiz(songId, pageLines) {
  if (quizCache.has(songId)) return quizCache.get(songId);
  const token = await getToken();
  if (!token) return { error: "no_token" };

  try {
    const [{ song }, referents] = await Promise.all([
      apiGet(`/songs/${songId}`, { text_format: "plain" }, token),
      fetchReferents(songId, token),
    ]);
    const album = song.album || {};
    const [albumDistractors, albumTracks] = await Promise.all([
      album.name
        ? fetchAlbumDistractors(song.primary_artist.id, album.name, token)
        : [],
      album.id ? fetchAlbumTracks(album.id, token) : [],
    ]);
    const quiz = buildQuiz(song, referents, albumDistractors, pageLines || []);
    if (quiz && albumTracks.length >= 2) {
      quiz.album = { id: album.id, name: album.name, tracks: albumTracks };
    }
    const result = quiz || { error: "not_enough_content" };
    quizCache.set(songId, result);
    return result;
  } catch (e) {
    if (String(e).includes(" 401 ")) return { error: "bad_token" };
    return { error: "api_error", detail: String(e) };
  }
}

/* ---- AI share card via Gemini image generation ("Nano Banana") ---- */

const GEMINI_MODEL = "gemini-2.5-flash-image";

function cardPrompt({ score, total, points, verdict, songTitle, artist }) {
  return [
    "Design a bold square social-media share card image.",
    "Style: punk zine / editorial magazine collage — dominant bright yellow",
    "(#FFFF64) background, thick black ink borders, halftone textures, torn",
    "off-white paper scraps, chunky black grotesque typography, sticker",
    "shapes with hard offset shadows, playful hand-drawn doodles (lightning",
    "bolts, stars, arrows).",
    `Main content: a giant score "${score}/${total}", the verdict headline`,
    `"${verdict.replace(/\.$/, "").toUpperCase()}", the song title "${songTitle}"`,
    `by ${artist}, a small badge reading "SONG TRIVIA", and "${points} PTS".`,
    "No other words. High contrast, crisp, centered composition, no photos",
    "of real people.",
  ].join(" ");
}

async function generateShareCard(payload) {
  const { geminiKey } = await chrome.storage.sync.get("geminiKey");
  if (!geminiKey) return { error: "no_gemini_key" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: cardPrompt(payload) }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
      }
    );
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      return { error: `gemini_${res.status}`, detail };
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
    if (!img) return { error: "gemini_no_image" };
    const blob = img.inlineData || img.inline_data;
    return { image: `data:${blob.mimeType || blob.mime_type || "image/png"};base64,${blob.data}` };
  } catch (e) {
    return { error: "gemini_error", detail: String(e) };
  }
}

async function hasGeminiKey() {
  const { geminiKey } = await chrome.storage.sync.get("geminiKey");
  return { hasKey: !!geminiKey };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_QUIZ") {
    getQuiz(msg.songId, msg.pageLines).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "GEN_CARD") {
    generateShareCard(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === "HAS_GEMINI_KEY") {
    hasGeminiKey().then(sendResponse);
    return true;
  }
  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});
