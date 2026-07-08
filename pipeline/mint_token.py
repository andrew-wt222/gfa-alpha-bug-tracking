"""Mint a Genius API access token and copy it to the clipboard.

For setting up the Verse IQ Chrome extension: run this, then paste into
the extension's options page. The token is never printed to the terminal.

  source ~/.genius_env   # GENIUS_CLIENT_ID + GENIUS_CLIENT_SECRET
  python3 pipeline/mint_token.py
"""

import subprocess
import sys

from genius_client import GeniusClient


def main():
    token = GeniusClient._exchange_client_credentials()
    if not token:
        sys.exit("Set GENIUS_CLIENT_ID and GENIUS_CLIENT_SECRET first.")
    subprocess.run(["pbcopy"], input=token.encode(), check=True)
    print(f"Access token ({len(token)} chars) copied to clipboard — paste it "
          "into the Verse IQ extension options page.")


if __name__ == "__main__":
    main()
