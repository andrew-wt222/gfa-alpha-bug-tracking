"""Minimal Genius API client for the quiz pipeline.

Uses the official OAuth API (https://api.genius.com) with a client access
token from https://genius.com/api-clients:
  export GENIUS_ACCESS_TOKEN=...

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
import urllib.parse
import urllib.request

API_BASE = "https://api.genius.com"
FIXTURE_DIR = pathlib.Path(__file__).parent / "fixtures"


class GeniusClient:
    def __init__(self, access_token=None, use_fixtures=False):
        self.access_token = access_token or os.environ.get("GENIUS_ACCESS_TOKEN")
        self.use_fixtures = use_fixtures
        if not self.use_fixtures and not self.access_token:
            raise RuntimeError(
                "Set GENIUS_ACCESS_TOKEN, or run with --fixture for offline demo data"
            )

    def _get(self, path, **params):
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        req = urllib.request.Request(f"{API_BASE}{path}?{query}")
        req.add_header("Authorization", f"Bearer {self.access_token}")
        with urllib.request.urlopen(req, timeout=30) as resp:
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
