# Small Room Radio

Ten venues each in San Francisco and Brooklyn, and eight genre keys. Every station plays 3–5 songs from each band booked there in the coming months, with a ticket link on every song.

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The website |
| `shows.json` | Upcoming shows for 20 venues. San Francisco: the first six pulled Nov 1 2026, The Fillmore, Regency Ballroom, Great American Music Hall and SFJAZZ Center added Nov 3. Brooklyn (each venue has `"city":"brooklyn"`): Baby's All Right, Union Pool, Music Hall of Williamsburg, National Sawdust, Brooklyn Steel, Elsewhere, Market Hotel, The Sultan Room, Saint Vitus and Warsaw, pulled Nov 4. The nightly songs job reads every venue, whatever the city. |
| `rain-core.js`, `rain-worklet.js` | Rain Through a Window mode (the switch on top of the radio): the rev D circuit model, and the same model as an AudioWorklet |
| `genres.json` | Which station each artist plays on. Anyone not listed goes to Indie |
| `build_tracks.py` | Finds each artist's songs on YouTube and writes `tracks.json` |
| `tracks.json` | Created by the script. The site plays whatever is in here |

## Step 1: Get a free YouTube API key (10 minutes)

1. Go to console.cloud.google.com and sign in with any Google account.
2. Create a project (any name, e.g. "small room radio").
3. Search for **YouTube Data API v3** and click **Enable**.
4. Go to **Credentials → Create credentials → API key**. Copy the key.

It's free. No credit card needed.

## Step 2: Find the songs

On your computer, in this folder:

```
python3 build_tracks.py YOUR_API_KEY
```

YouTube's free quota covers about 95 artists per day, so run it once a day for 4 days. It remembers its progress and does the soonest shows first, so November's bands are playable after day one.

**Fixing wrong matches.** Bands with common names (Q, Dice, Token, Valley, Lace) may pull up the wrong artist. Open `tracks.json`, find the band, and either replace the `id` with the right YouTube video ID (the part after `watch?v=`) or set the band to `[]` and run the script with `--retry`.

## Step 3: Put it online for free (GitHub Pages)

1. Make a free account at github.com.
2. Click **New repository**, name it `small-room-radio`, make it Public, and create it.
3. Click **uploading an existing file** and drag in everything in this folder (including `tracks.json`).
4. Go to **Settings → Pages**, set Source to **main branch / root**, and save.
5. After a minute your site is live at `https://YOUR-USERNAME.github.io/small-room-radio/`.

To update later, upload the new `tracks.json` or `shows.json` the same way.

**Shareable station links.** Every station has its own link, which is good for tweets. For example:
`.../small-room-radio/#bottom-of-the-hill-punk` or `#rickshaw-stop-hiphop`.

## Keeping it fresh

Show listings change. Once a month, ask me to refresh `shows.json`, then rerun `build_tracks.py` (it only looks up new artists).

## Optional: your own domain

A domain like smallroom.fm costs about $10–40/year. GitHub Pages supports custom domains under Settings → Pages.
