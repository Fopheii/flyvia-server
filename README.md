# Flyvia Server

Live flight tracking backend. Polls [OpenSky Network](https://opensky-network.org/) every 30 seconds and serves cached data via a REST API.

## Stack

- Node.js 18+
- Express
- node-cron

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server status, cache size, uptime |
| GET | `/flights` | All cached airborne flights |
| GET | `/flights/:country` | Flights filtered by origin country |

### Examples

```
GET /flights
GET /flights/United States
GET /health
```

## Run locally

```bash
npm install
npm start
```

Server starts on `http://localhost:3000`.

## Deploy to Railway

1. Push this repo to GitHub.
2. Create a new Railway project → **Deploy from GitHub repo**.
3. Railway auto-detects `npm start` from `package.json` — no extra config needed.
4. The `PORT` environment variable is set automatically by Railway.

## How it works

OpenSky's `/states/all` endpoint is queried across 4 geographic bounding-box zones in parallel to cover the whole world:

| Zone | Coverage |
|------|----------|
| Americas | lon −180 → −60 |
| Atlantic | lon −60 → 0 |
| Europe / Africa | lon 0 → 60 |
| Asia / Pacific | lon 60 → 180 |

Results are deduplicated by callsign, filtered to airborne flights only (non-empty callsign + `on_ground === false`), and held in memory until the next poll.

## Notes

- OpenSky anonymous access is rate-limited (~1 req/10 s per IP per endpoint). The 4-zone split counts as 4 requests per cycle; if you hit limits, increase the cron interval or add OpenSky credentials via `OPENSKY_USERNAME` / `OPENSKY_PASSWORD` environment variables and pass them as Basic Auth headers in `fetchZone`.
- No persistent storage — the cache resets on restart.
