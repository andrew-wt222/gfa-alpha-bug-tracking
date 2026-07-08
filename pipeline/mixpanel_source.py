"""Pull the (song_id, annotation_id) engagement ranking out of Mixpanel.

The Genius Production Mixpanel project (446209) tracks `song:open_annotation`
with both a `Song ID` and an `annotation_id` property, so a single grouped
query gives us, per song, which annotations exist and how often readers open
them. That ranking drives both song selection (which pages get a quiz) and
question ordering (heavily-opened annotations make easier questions).

Auth uses a Mixpanel service account:
  export MIXPANEL_SERVICE_ACCOUNT="username:secret"
  export MIXPANEL_PROJECT_ID=446209

Usage:
  python3 pipeline/mixpanel_source.py --from 2026-04-01 --to 2026-07-08 \
      --out data/mixpanel_top_annotations.json
"""

import argparse
import base64
import datetime as dt
import json
import os
import sys
import urllib.request

JQL_SCRIPT = """
function main() {
  return Events({
    from_date: params.from_date,
    to_date: params.to_date,
    event_selectors: [{event: "song:open_annotation"}]
  })
  .filter(e => e.properties["Song ID"] && e.properties["annotation_id"])
  .groupBy(
    [e => e.properties["Song ID"], e => e.properties["annotation_id"]],
    mixpanel.reducer.count()
  )
  .sortDesc("value");
}
"""


def fetch_rows(service_account, project_id, from_date, to_date):
    payload = {
        "script": JQL_SCRIPT,
        "params": json.dumps({"from_date": from_date, "to_date": to_date}),
    }
    body = "&".join(
        f"{k}={urllib.request.quote(v)}" for k, v in payload.items()
    ).encode()
    req = urllib.request.Request(
        f"https://mixpanel.com/api/query/jql?project_id={project_id}",
        data=body,
        method="POST",
    )
    token = base64.b64encode(service_account.encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=60) as resp:
        results = json.load(resp)
    # JQL rows: {"key": [song_id, annotation_id], "value": count}
    return [
        [int(r["key"][0]), int(r["key"][1]), int(r["value"])] for r in results
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="from_date", required=True)
    parser.add_argument("--to", dest="to_date", required=True)
    parser.add_argument("--out", default="data/mixpanel_top_annotations.json")
    parser.add_argument("--limit", type=int, default=3000)
    args = parser.parse_args()

    service_account = os.environ.get("MIXPANEL_SERVICE_ACCOUNT")
    project_id = os.environ.get("MIXPANEL_PROJECT_ID", "446209")
    if not service_account:
        sys.exit("Set MIXPANEL_SERVICE_ACCOUNT=username:secret (service account)")

    rows = fetch_rows(service_account, project_id, args.from_date, args.to_date)
    doc = {
        "_meta": {
            "source": f"Mixpanel project {project_id} (Genius Production)",
            "event": "song:open_annotation",
            "properties": ["Song ID", "annotation_id"],
            "window": {"from": args.from_date, "to": args.to_date},
            "exported_at": dt.date.today().isoformat(),
            "row_format": ["song_id", "annotation_id", "opens"],
        },
        "rows": rows[: args.limit],
    }
    with open(args.out, "w") as f:
        json.dump(doc, f, indent=2)
    print(f"Wrote {len(doc['rows'])} rows to {args.out}")


if __name__ == "__main__":
    main()
