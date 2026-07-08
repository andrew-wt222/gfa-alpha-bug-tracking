const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.sync.get("geniusToken").then(({ geniusToken }) => {
  if (geniusToken) status.textContent = "A token is saved. Paste a new one to replace it.";
});

document.getElementById("save").onclick = async () => {
  const token = tokenInput.value.trim();
  if (!token) { status.textContent = "Paste a token first."; return; }
  await chrome.storage.sync.set({ geniusToken: token });
  tokenInput.value = "";
  status.textContent = "Saved. Reload the Genius tab to play.";
};
