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

async function getQuiz(songId) {
  if (quizCache.has(songId)) return quizCache.get(songId);
  const token = await getToken();
  if (!token) return { error: "no_token" };

  try {
    const [{ song }, referents] = await Promise.all([
      apiGet(`/songs/${songId}`, { text_format: "plain" }, token),
      fetchReferents(songId, token),
    ]);
    const albumDistractors = (song.album || {}).name
      ? await fetchAlbumDistractors(song.primary_artist.id, song.album.name, token)
      : [];
    const quiz = buildQuiz(song, referents, albumDistractors);
    const result = quiz || { error: "not_enough_content" };
    quizCache.set(songId, result);
    return result;
  } catch (e) {
    if (String(e).includes(" 401 ")) return { error: "bad_token" };
    return { error: "api_error", detail: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_QUIZ") {
    getQuiz(msg.songId).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
  }
});
