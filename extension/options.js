const tokenInput = document.getElementById("token");
const geminiInput = document.getElementById("gemini");
const status = document.getElementById("status");

chrome.storage.sync.get(["geniusToken", "geminiKey"]).then(({ geniusToken, geminiKey }) => {
  const saved = [geniusToken && "Genius token", geminiKey && "Gemini key"].filter(Boolean);
  if (saved.length) status.textContent = `Saved: ${saved.join(" + ")}. Paste a new value to replace it.`;
});

document.getElementById("save").onclick = async () => {
  const token = tokenInput.value.trim();
  const gemini = geminiInput.value.trim();
  if (!token && !gemini) { status.textContent = "Paste a token or key first."; return; }
  const update = {};
  if (token) update.geniusToken = token;
  if (gemini) update.geminiKey = gemini;
  await chrome.storage.sync.set(update);
  tokenInput.value = "";
  geminiInput.value = "";
  status.textContent = "Saved. Reload the Genius tab to play.";
};
