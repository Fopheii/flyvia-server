const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const https = require('https');

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

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
  const username = process.env.OPENSKY_USERNAME;
  const password = process.env.OPENSKY_PASSWORD;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (username && password) {
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
    console.log('Fetching OpenSky zone (authenticated):', url);
  } else {
    console.log('Fetching OpenSky zone (anonymous):', url);
  }

  const response = await fetch(url, {
    headers,
    agent: httpsAgent,
    timeout: 15000,
  });

  console.log('OpenSky response status:', response.status, 'for zone', query);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  console.log('OpenSky states count:', data?.states?.length ?? 0, 'for zone', query);
  return data.states || [];
}

async function fetchAllFlights() {
  console.log('Cron job triggered at:', new Date().toISOString());
  try {
    const results = await Promise.allSettled(ZONES.map(fetchZone));

    // Log any zone-level failures
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Zone ${i} failed:`, r.reason?.message || r.reason);
      }
    });

    const states = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    console.log('Total raw states across all zones:', states.length);

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
