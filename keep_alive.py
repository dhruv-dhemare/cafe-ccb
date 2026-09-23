"""Keep the Render demo service warm while this script is running.

Run with:
    python keep_alive.py

Stop with Ctrl+C. This is only suitable for temporary demos; it requires
the computer running this script to remain powered on and connected.
"""

import os
import sys
import time
import urllib.error
import urllib.request


SERVICE_URL = os.getenv(
    "RENDER_SERVICE_URL",
    "https://cafe-ccb-api.onrender.com/api/menu",
)
INTERVAL_SECONDS = 10 * 60


def ping() -> None:
    request = urllib.request.Request(
        SERVICE_URL,
        headers={"User-Agent": "CCB-demo-keep-alive/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Render responded {response.status}")
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Ping failed: {error}")


if __name__ == "__main__":
    if "--once" in sys.argv:
        ping()
        raise SystemExit
    print(f"Keeping {SERVICE_URL} warm every {INTERVAL_SECONDS // 60} minutes.")
    try:
        while True:
            ping()
            time.sleep(INTERVAL_SECONDS)
    except KeyboardInterrupt:
        print("Keep-alive stopped.")
