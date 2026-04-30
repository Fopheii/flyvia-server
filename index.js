const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Fetch entire world split into 4 bbox zones to stay within OpenSky rate limits
const ZONES = [
  'lamin=-60&lamax=90&lomin=-180&lomax=-60', // Americas
  'lamin=-60&lamax=90&lomin=-60&lomax=0',    // Atlantic
  'lamin=-60&lamax=90&lomin=0&lomax=60',     // Europe/Africa
  'lamin=-60&lamax=90&lomin=60&lomax=180',   // Asia/Pacific
];

const OPENSKY_BASE = 'https://opensky-network.org/api/states/all';

let flightCache = [];
let lastUpdated = null;
let fetchErrors = 0;

function mapState(state) {
  return {
    id: (state[0] || '').trim(),
    callsign: (state[0] || '').trim(),
    country: state[2] || '',
    lat: state[6],
    lon: state[5],
    altitude: state[7],
    speed: state[9],
    heading: state[10],
    on_ground: state[8],
  };
}

async function fetchZone(query) {
  const url = `${OPENSKY_BASE}?${query}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'flyvia-server/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OpenSky responded ${res.status} for zone ${query}`);
  const data = await res.json();
  return data.states || [];
}

async function fetchAllFlights() {
  try {
    const results = await Promise.allSettled(ZONES.map(fetchZone));

    const states = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

    const flights = states
      .map(mapState)
      .filter((f) => f.callsign && !f.on_ground);

    // Deduplicate by callsign (zones have slight overlap)
    const seen = new Set();
    const unique = flights.filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });

    flightCache = unique;
    lastUpdated = new Date().toISOString();
    fetchErrors = 0;
    console.log(`[${lastUpdated}] Cached ${unique.length} flights`);
  } catch (err) {
    fetchErrors++;
    console.error(`Fetch error (${fetchErrors}):`, err.message);
  }
}

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    flights_cached: flightCache.length,
    last_updated: lastUpdated,
    fetch_errors: fetchErrors,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// GET /flights
app.get('/flights', (_req, res) => {
  res.json({
    count: flightCache.length,
    last_updated: lastUpdated,
    flights: flightCache,
  });
});

// GET /flights/:country
app.get('/flights/:country', (req, res) => {
  const target = req.params.country.toLowerCase();
  const filtered = flightCache.filter(
    (f) => f.country.toLowerCase() === target
  );
  res.json({
    country: req.params.country,
    count: filtered.length,
    last_updated: lastUpdated,
    flights: filtered,
  });
});

// Fetch immediately on startup, then every 30 seconds
fetchAllFlights();
cron.schedule('*/30 * * * * *', fetchAllFlights);

app.listen(PORT, () => {
  console.log(`Flyvia server running on port ${PORT}`);
});
