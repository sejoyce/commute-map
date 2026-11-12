# Commute Map

Draw travel-time areas (drive, walk, bike, transit) around an address, then show listings inside the overlap.

## Run locally
    npm install
    cp .env.example .env     # add keys
    npm run build:gtfs       # one-time: bake the MBTA timetable (see below)
    npm run dev

Free keys: openrouteservice.org (drive/walk/bike), geoapify.com (transit fallback), rentcast.io (listings).
Without a RentCast key the app uses random sample listings so you can test the flow.

## Transit
Transit areas are calculated from the agency's real timetable (GTFS) with the RAPTOR algorithm,
for the departure time set in the sidebar. Walking from your address to a station, and from the
last station to a destination, is estimated from straight-line distance x 1.3 at 3 mph, not from
street routing, so the edges are approximate. Vehicle changes need at least 1 minute.

`npm run build:gtfs` downloads the MBTA feed and writes `public/gtfs/mbta.json` for one service date
(the next weekday by default). Options:

    npm run build:gtfs -- --date 2026-11-18    # a specific date (must be inside the feed's range)
    npm run build:gtfs -- --no-bus             # subway, light rail, commuter rail, ferry only (smaller)
    npm run build:gtfs -- --zip ./MBTA_GTFS.zip   # use a feed you already downloaded

Re-run it whenever MBTA publishes a new schedule, or the times will go stale. Commit the generated
file if you deploy to GitHub Pages or Firebase, since the browser loads it as a static file.

Addresses outside the MBTA area (or any address if the file hasn't been built) fall back to
Geoapify's estimate, which doesn't use real timetables. The note under the form says which method
produced each area. To cover another metro, point `--url` at its GTFS feed and `--out` at a new file
(the app currently loads one file, `gtfs/mbta.json`).

`npm test` checks the builder and router against a small fake network with hand-computed answers.

## Deploy
**GitHub Pages:** `npm run build`, then publish `dist/` (e.g. the `gh-pages` package, or a GitHub Actions workflow).
**Firebase Hosting:** `firebase init hosting`, set public dir to `dist`, then `firebase deploy`.

## Before you share the site
Vite bakes VITE_* keys into the JS, so anyone can read them from a static host. For a public deploy,
move the calls in `src/api.js` behind Firebase Cloud Functions (keys stored as secrets) and point
the fetch URLs at your function. Also add a referrer/usage limit on each provider's dashboard.
