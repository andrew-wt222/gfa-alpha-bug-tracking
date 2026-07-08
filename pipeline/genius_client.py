"""Minimal Genius API client for the quiz pipeline.

Uses the official OAuth API (https://api.genius.com). Auth, either form:
  export GENIUS_ACCESS_TOKEN=...            # client access token from
                                            # https://genius.com/api-clients
or let the client exchange app credentials for one at startup:
  export GENIUS_CLIENT_ID=...
  export GENIUS_CLIENT_SECRET=...           # POST /oauth/token (client_credentials)

Endpoints used:
  GET /songs/:id                       -> title, artist, description ("About")
  GET /referents?song_id=:id           -> lyric fragments + their annotations
  GET /annotations/:id                 -> single annotation (spot refresh)

Every method returns plain dicts shaped like the API's `response` payload.
When --fixture mode is on (or the network is unavailable), payloads are read
from pipeline/fixtures/genius_<song_id>.json instead, so the generator and
demo work offline.
"""

import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://api.genius.com"
FIXTURE_DIR = pathlib.Path(__file__).parent / "fixtures"
MAX_RETRIES = 4
BACKOFF_BASE_SECONDS = 2  # 2, 4, 8, 16 on 429/5xx


def _urlopen_with_retry(req):
    """Polite retry with exponential backoff on rate limits and server errors."""
    for attempt in range(MAX_RETRIES + 1):
        try:
            return urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            retryable = e.code == 429 or 500 <= e.code < 600
            if not retryable or attempt == MAX_RETRIES:
                raise
            retry_after = e.headers.get("Retry-After")
            delay = (
                float(retry_after)
                if retry_after and retry_after.isdigit()
                else BACKOFF_BASE_SECONDS * (2 ** attempt)
            )
            time.sleep(delay)


class GeniusClient:
    def __init__(self, access_token=None, use_fixtures=False):
        self.access_token = access_token or os.environ.get("GENIUS_ACCESS_TOKEN")
        self.use_fixtures = use_fixtures
        if not self.use_fixtures and not self.access_token:
            self.access_token = self._exchange_client_credentials()
        if not self.use_fixtures and not self.access_token:
            raise RuntimeError(
                "Set GENIUS_ACCESS_TOKEN (or GENIUS_CLIENT_ID + GENIUS_CLIENT_SECRET), "
                "or run with --fixture for offline demo data"
            )

    @staticmethod
    def _exchange_client_credentials():
        client_id = os.environ.get("GENIUS_CLIENT_ID")
        client_secret = os.environ.get("GENIUS_CLIENT_SECRET")
        if not (client_id and client_secret):
            return None
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        }).encode()
        req = urllib.request.Request(f"{API_BASE}/oauth/token", data=body, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with _urlopen_with_retry(req) as resp:
            return json.load(resp)["access_token"]

    def _get(self, path, **params):
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        req = urllib.request.Request(f"{API_BASE}{path}?{query}")
        req.add_header("Authorization", f"Bearer {self.access_token}")
        with _urlopen_with_retry(req) as resp:
            return json.load(resp)["response"]

    def _fixture(self, song_id):
        path = FIXTURE_DIR / f"genius_{song_id}.json"
        if not path.exists():
            raise FileNotFoundError(
                f"No fixture for song {song_id}. Available: "
                + ", ".join(p.stem for p in FIXTURE_DIR.glob("genius_*.json"))
            )
        return json.loads(path.read_text())

    def song(self, song_id):
        """Song metadata incl. title, artist, and description ('About')."""
        if self.use_fixtures:
            return self._fixture(song_id)["song"]
        return self._get(f"/songs/{song_id}", text_format="plain")["song"]

    def referents(self, song_id, per_page=50):
        """All referents (lyric fragments) for a song, with their annotations."""
        if self.use_fixtures:
            return self._fixture(song_id)["referents"]
        referents, page = [], 1
        while True:
            batch = self._get(
                "/referents",
                song_id=song_id,
                text_format="plain",
                per_page=per_page,
                page=page,
            )["referents"]
            referents.extend(batch)
            if len(batch) < per_page:
                return referents
            page += 1

    def annotation(self, annotation_id):
        if self.use_fixtures:
            for song in self._all_fixture_songs():
                for ref in song["referents"]:
                    for ann in ref["annotations"]:
                        if ann["id"] == annotation_id:
                            return ann
            raise KeyError(annotation_id)
        return self._get(f"/annotations/{annotation_id}", text_format="plain")[
            "annotation"
        ]

    def _all_fixture_songs(self):
        for path in FIXTURE_DIR.glob("genius_*.json"):
            yield json.loads(path.read_text())
