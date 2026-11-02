#!/usr/bin/env python3
"""
Finds 3-5 YouTube songs for every artist in shows.json and saves them to tracks.json.

Usage:
    python3 build_tracks.py YOUR_YOUTUBE_API_KEY

YouTube's free quota allows about 95 artist lookups per day, so with ~350 artists
run this once a day for 4 days. It remembers what it already found and picks up
where it left off. Artists with the soonest shows are looked up first.

To fix a wrong match, edit that artist's entry in tracks.json by hand
(or set it to [] and run with --retry).
"""
import html, json, re, sys, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).parent
SHOWS, TRACKS = HERE / "shows.json", HERE / "tracks.json"
PER_RUN = 95          # 95 searches x 100 units = 9,500 of the 10,000 daily units
TRACKS_PER_ARTIST = 5
SKIP_WORDS = re.compile(r"\b(live|interview|reaction|cover|karaoke|tutorial|full album|playlist)\b", re.I)


def norm(s):
    # "&" and "and" count as the same, so "Thao & The..." matches "Thao and the..."
    s = html.unescape(s).lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]", "", s)


def search(key, artist):
    params = {
        "part": "snippet", "type": "video", "videoEmbeddable": "true",
        "videoCategoryId": "10", "maxResults": "15", "key": key,
        "q": f'"{artist}" song',
    }
    url = "https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=20) as r:
        return json.load(r).get("items", [])


def pick(items, artist):
    a = norm(artist)
    scored, seen = [], set()
    for it in items:
        sn = it["snippet"]
        title, channel = html.unescape(sn["title"]), html.unescape(sn["channelTitle"])
        if SKIP_WORDS.search(title):
            continue
        ch, ti = norm(channel), norm(title)
        if a not in ch and a not in ti:
            continue  # probably a different artist with a similar name
        song = re.sub(r"\(.*?\)|\[.*?\]", "", title).split(" - ")[-1].strip().lower()
        if song in seen:
            continue
        seen.add(song)
        score = 3 if channel.endswith("- Topic") and a in ch else 2 if a in ch else 1
        scored.append((score, {"id": it["id"]["videoId"], "title": title}))
    scored.sort(key=lambda x: -x[0])  # stable: keeps YouTube's relevance order within a tier
    return [t for _, t in scored[:TRACKS_PER_ARTIST]]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    key, retry = sys.argv[1], "--retry" in sys.argv
    shows = json.loads(SHOWS.read_text())["venues"]
    tracks = json.loads(TRACKS.read_text()) if TRACKS.exists() else {}

    first_date = {}
    for v in shows.values():
        for date, artists, _ in v["shows"]:
            for a in artists:
                first_date[a] = min(first_date.get(a, date), date)
    todo = [a for a in sorted(first_date, key=first_date.get)
            if a not in tracks or (retry and not tracks[a])]
    print(f"{len(first_date)} artists, {len(todo)} still to look up. Doing up to {PER_RUN} now.")

    done, stopped = 0, False
    for artist in todo[:PER_RUN]:
        found = None
        for attempt in (1, 2):
            try:
                found = pick(search(key, artist), artist)
                break
            except urllib.error.HTTPError as e:
                reason = e.read().decode("utf-8", "ignore")
                if e.code == 429 and attempt == 1 and "quota" not in reason.lower():
                    print("  YouTube says slow down. Waiting a minute...")
                    time.sleep(60)
                    continue
                if e.code in (403, 429):
                    print("\nYouTube stopped the lookups for today (daily limit reached).")
                    print("Everything found so far is saved. Run the same command again after midnight Pacific.")
                else:
                    print(f"\nYouTube returned an error ({e.code}). Everything found so far is saved.")
                    print(reason[:300])
                stopped = True
                break
            except urllib.error.URLError as e:
                print(f"\nCouldn't reach YouTube ({e.reason}). Check your internet and run again.")
                stopped = True
                break
        if stopped:
            break
        time.sleep(1)  # be gentle: about one search per second
        tracks[artist] = found
        done += 1
        print(f"  {artist}: {len(found)} songs")
        TRACKS.write_text(json.dumps(tracks, indent=1, ensure_ascii=False))

    left = len([a for a in first_date if a not in tracks])
    print(f"Looked up {done}. {left} artists left" + (" - run again tomorrow." if left else " - all done!"))


if __name__ == "__main__":
    main()
