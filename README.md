<div align="center">
  <img src="public/icons/icon.svg" width="88" height="88" alt="">
  <h1>Naija Routes</h1>
  <p><strong>Community road intelligence for Nigeria.</strong><br>
  Plan a journey, see what the road is actually like right now, and let someone know you got there.</p>
  <p>
    <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.11-3f9b6d?style=flat-square">
    <img alt="Dependencies" src="https://img.shields.io/badge/runtime%20deps-2-ffc328?style=flat-square">
    <img alt="Tests" src="https://img.shields.io/badge/tests-73%20passing-3f9b6d?style=flat-square">
    <img alt="Offline" src="https://img.shields.io/badge/works%20offline-yes-8b6fd4?style=flat-square">
  </p>
</div>

---

Every Nigerian driver already runs this app in their head. Which road floods in
July. Where the potholes start after Ore. Whether the filling station at Sagamu
still has fuel and what they are charging. Which stretch you do not drive after
dark. That knowledge lives in WhatsApp groups and in people's memories, and it
expires before it reaches the person who needs it.

Naija Routes is that knowledge, on a map, with a clock on it.

```bash
git clone https://github.com/callmekomen/Geo-location.git
cd Geo-location
npm install
npm start          # → http://localhost:3000
```

No API key. No account. No internet connection required. The bundled road graph
and gazetteer mean routing, search and the assistant all work on a laptop in
aeroplane mode.

---

## What it does

### Plan
Type two places and get a route with turn-by-turn directions, distance,
duration, arrival time, and up to two genuinely different alternatives — not the
same road drawn twice. Fuel cost is estimated from your vehicle type and how
much is in the tank, priced with the median of what drivers actually reported at
the pump this week.

### Know
Every planned route is scanned against the live report database. Reports inside
the corridor are matched to the line, so you get a **Route Safety Score from 0
to 100** and a hazard timeline: what is on the road, how far along, roughly when
you will reach it, how confident the crowd is in the report, and which 40 km
stretch is the worst of the journey.

```
 78  SAFETY        Lagos → Benin City
 ●──────────●─────────────●──●──────────────────────  292 km · 3h 23m
 🌊 12 km    🕳️ 84 km      🛃 171 km
```

Advisories are raised for things worth saying out loud: arrival after dark on a
route with security reports, a fuel gap with no confirmed station in range, a
flooded section during the rains.

### Report
Sixteen report types across road, traffic, security, fuel and place updates.
Every report carries a severity, a confidence score and an expiry that suits its
type — a fuel price is stale in twelve hours, a pothole is still there in a
month. Other drivers confirm or dispute; confirmations extend the life of a
report, disputes retire it. Report the same thing someone else just reported
250 m away and it folds in as a confirmation rather than cluttering the map.

Reports made with no signal queue on the device and publish themselves when you
reconnect.

### Arrive
Start a trip and you get a six-character code. Anyone with it opens
`/t/ABC123` — no app, no login — and sees your position, your progress, your
expected arrival counting down, and the hazards still ahead of you. Go twenty
minutes past your ETA and the page says so. There is an SOS button, and a
check-in button for when you just want to say you are fine.

### Live
A Server-Sent Events feed pushes new reports, confirmations, trip pings and SOS
signals to every open map in real time.

### Ask
A chat panel that answers from the database, deterministically, with no API key:

> **How far from Ikeja to Benin City?**
> 292 km, about 3h 23m by car. Safety score 54 out of 100 — drive with care.
> Six reports on the corridor, the worst being a gridlock at Ikeja.

> **Is there fuel on the way to Ibadan?**
> Four stations reported selling along that route in the last day. Cheapest is
> NNPC Sagamu at ₦1,020/L, 61 km in. Median around Lagos is ₦1,080/L.

Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and it will phrase the same
facts more naturally. The facts always come from the database, never from the
model.

---

## Why it works without the internet

Most mapping apps are a thin client in front of somebody else's server. That is
a bad fit for a country where the connection drops between Lokoja and Okene.

| Concern | Online | Offline (default fallback) |
| --- | --- | --- |
| Routing | OSRM, if reachable | **A\* over a bundled graph** — 189 places, 250 road links, 17,218 km |
| Geocoding | Nominatim | **Bundled gazetteer** — 189 places across all 36 states and the FCT, with fuzzy search |
| Basemap | OSM / CARTO tiles | Cached tiles, then a plain drawn background |
| Assistant | Optional LLM phrasing | **Built-in reasoning over the database** |
| Reports, trips, insights | Local SQLite | Local SQLite |

Upstream services are wrapped in a circuit breaker: two timeouts and the app
stops asking for sixty seconds and serves the offline engine instead. You get a
route either way. The engine in use is shown in the top bar at all times.

### The routing engine

A\* over the bundled highway graph, with cost measured in seconds rather than
metres, so an expressway beats a shorter back road:

- **Road classes** carry their own speed and sinuosity: expressway 92 km/h ×1.07,
  trunk 76 ×1.12, primary 61 ×1.16, secondary 46 ×1.22, urban 24 ×1.30.
- **Virtual-node snapping** projects your start and end onto the nearest
  segments — up to four candidates on distinct roads — so routing from a point
  in the middle of nowhere still works. Access legs are costed at 22 km/h with a
  1.35 detour factor.
- **A 35-second turn penalty** on every road-name change keeps the engine from
  proposing zig-zags to save one kilometre.
- **Alternatives** re-run the search with the used edges weighted ×2.2, and are
  only offered if they share less than 62 % of their named roads with the first
  route and take less than 1.45× as long. The safer of the two is labelled as
  such.

### Scoring a route

Each hazard inside the corridor contributes
`weight × severity × confidence × proximity`, normalised against trip length so
a single pothole does not ruin a 600 km drive and does not vanish on a 10 km
one. Confidence decays with age and rises with confirmations:

```
confidence = clamp(0.5 + 0.13·confirms − 0.2·disputes, 0.03, 1) × (0.35 + 0.65·freshness)
```

Grades: **85+** clear · **68+** fair · **48+** caution · **28+** rough · below
that, severe.

---

## The stack

Deliberately small. Two runtime dependencies: `express` and `compression`.

```
server/
  app.js              route table, static files, SPA fallback
  index.js            boot, sweeps, graceful shutdown
  config.js           .env loader with sane defaults
  db/                 schema, seed, and a driver that prefers better-sqlite3
                      and falls back to node:sqlite
  services/
    geo.js            haversine, bearings, point-to-polyline, simplify, polyline codec
    gazetteer.js      offline place search with typo tolerance and distance bias
    graph.js          the A* routing engine
    taxonomy.js       the 16 report types and what they mean
    reports.js        create, dedupe, vote, expire, cluster into hotspots
    hazards.js        corridor matching and the safety score
    fuel.js           station clustering, market price, refuelling plan
    trips.js          trip lifecycle, progress, live ETA, overdue sweep
    planner.js        ties routing + hazards + fuel into one answer
    assistant.js      intent parsing and deterministic answers
    events.js         the SSE bus
    upstream.js       OSRM/Nominatim clients with circuit breakers
  routes/             one file per resource
public/
  index.html          the app shell
  track.html          the public trip-watch page
  js/                 plain ES modules, no build step
  css/app.css         one stylesheet, CSS custom properties
  sw.js               offline shell, tile cache, network-first API
data/
  places.json         the gazetteer
  highways.json       the road graph
test/                 73 tests, including a headless run of the real UI
```

The front end has **no build step**. It is ES modules and one stylesheet,
served as-is. Leaflet is vendored into `public/vendor/` at install time so
nothing is fetched from a CDN at runtime.

### Testing

```bash
npm test          # 73 tests, ~2 seconds
npm run verify    # checks the bundled map data for broken links and bad coordinates
```

`test/ui.test.js` boots the actual front end inside jsdom against a real server
with a stubbed Leaflet, then drives it: switches tabs, types into the
autocomplete, plans a route, opens the report dialog and posts a report, starts
a trip, loads the guardian page for that trip's code, and asks the assistant a
question. If an element id drifts out of sync with the JavaScript, the suite
fails.

`test/leaflet.test.js` runs the same app against the **real** vendored Leaflet
and asserts on the SVG paths, markers and panes that actually land in the DOM —
a stub will happily accept a call the real library would reject. It also
verifies the `<dialog>` fallback used by iOS Safari before 15.4.

There is no browser in CI, so between them these two files stand in for one.

---

## Configuration

Copy `.env.example` to `.env`. Every value is optional.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `DATABASE_PATH` | `./data/runtime/naija-routes.db` | SQLite file |
| `SEED_ON_BOOT` | `1` | 52 demo reports on an empty database |
| `UPSTREAM_ENABLED` | `1` | `0` forces pure-offline mode |
| `OSRM_URL` | `router.project-osrm.org` | |
| `NOMINATIM_URL` | `nominatim.openstreetmap.org` | |
| `CONTACT_EMAIL` | — | sent in the user agent, as Nominatim's policy requires |
| `ASSISTANT_PROVIDER` | `none` | `anthropic` or `openai` for phrasing only |
| `RATE_LIMIT_MAX` | `240`/min | `REPORT_RATE_LIMIT_MAX` is `20`/min |

### Docker

```bash
docker compose up --build      # → http://localhost:3000
```

Reports persist in the `naija-data` volume.

---

## API

Everything under `/api`. Anonymous, identified by an `x-device-id` header the
browser generates once and keeps. Trip owners also hold an `x-trip-token`.

| | |
| --- | --- |
| `GET /api/health` | liveness |
| `GET /api/meta` | report types, vehicles, states, engine status, live counts |
| `GET /api/places?q=` | place search, offline-first |
| `GET /api/places/reverse?lat=&lon=` | name a coordinate |
| `POST /api/route` | plan, scan hazards, price the fuel |
| `GET /api/around?lat=&lon=` | what is near a point |
| `GET /api/reports` | filter by bbox, category, type, age |
| `POST /api/reports` | add one (deduped against recent neighbours) |
| `POST /api/reports/:id/vote` | `confirm` or `dispute` |
| `GET /api/reports/hotspots` | clustered trouble spots |
| `GET /api/reports/stations` | fuel stations with prices |
| `POST /api/trips` | start a shared trip → code + token |
| `GET /api/trips/:code` | public view: position, progress, ETA, hazards ahead |
| `POST /api/trips/:code/ping` | position update (token) |
| `POST /api/trips/:code/sos` | raise or clear an emergency (token) |
| `POST /api/trips/:code/checkin` | "I'm fine" (token) |
| `POST /api/trips/:code/status` | arrived / cancelled (token) |
| `GET /api/insights?days=` | aggregates, trends, hotspots, fuel market |
| `POST /api/assistant` | ask a question |
| `GET /api/stream` | SSE feed — `?topics=report:new,trip:sos` |

<details>
<summary>Plan a route from the command line</summary>

```bash
curl -s localhost:3000/api/route \
  -H 'content-type: application/json' \
  -d '{"from":"Ikeja","to":"Benin City","vehicle":"car","tankPct":0.4}' |
  python3 -m json.tool | head -40
```
</details>

---

## The data

`data/places.json` and `data/highways.json` are hand-curated: 189 places across
all 36 states and the FCT, joined by 250 road links covering roughly 17,218 km
of the primary network. It is not OpenStreetMap-complete and is not trying to
be — it is a skeleton accurate enough to route between real Nigerian towns
without downloading a 700 MB extract.

Adding a road is two lines of JSON:

```json
{ "a": "ore", "b": "benin-city", "class": "expressway", "name": "Benin–Ore Expressway" }
```

Then run `npm run verify`, which will tell you if the place ids do not exist,
the graph has been cut in two, or a coordinate has wandered out of the country.

---

## Things worth knowing

- **Nothing here is a login.** A device id in `localStorage` is the whole
  identity model. Trip tokens are the only secret, and they never leave the
  owner's browser.
- **Reports expire on purpose.** A map full of last year's potholes is worse
  than an empty one.
- **The safety score is a heuristic, not a guarantee.** It reflects what people
  reported, which is not the same as what is there.
- **Coordinates are approximate town centres.** Good enough to route and snap,
  not survey-grade.

## History

The original single-file prototype that started this is kept at
[`docs/prototype-v1.html`](docs/prototype-v1.html) for reference. It is not
served by the app.

## Licence

MIT — see [LICENSE](LICENSE).

Basemap tiles © OpenStreetMap contributors, used under the ODbL when online.
Leaflet is BSD-2-Clause.
