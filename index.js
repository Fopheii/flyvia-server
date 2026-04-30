const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const AIRPORTS = [
  'KJFK', 'KMIA', 'KLAX', 'KATL',
  'MDSD', 'MDPC', 'TJSJ', 'MMMX',
  'SKBO', 'SBGR', 'CYYZ', 'MPTO',
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let flightCache = [];
let lastUpdated = null;
let nextRefresh = null;
let fetchErrors = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildTimeWindow() {
  const now = new Date();
  const from = now.toISOString().slice(0, 16);
  const to = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString().slice(0, 16);
  return { from, to };
}

function mapFlight(flight, type) {
  const number = flight.number || flight.callsign || '';
  return {
    id: number,
    callsign: number,
    airline: flight.airline?.name || '',
    status: flight.status || '',
    type,                                          // 'departure' | 'arrival'
    origin: flight.departure?.airport?.icao || '',
    destination: flight.arrival?.airport?.icao || '',
    scheduledDep: flight.departure?.scheduledTime?.utc || null,
    scheduledArr: flight.arrival?.scheduledTime?.utc || null,
    actualDep: flight.departure?.actualTime?.utc || null,
    actualArr: flight.arrival?.actualTime?.utc || null,
  };
}

async function fetchAirport(icao) {
  const key = process.env.AERODATABOX_KEY;
  if (!key) throw new Error('AERODATABOX_KEY env var not set');

  const { from, to } = buildTimeWindow();
  const url = `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${icao}/${from}/${to}`;

  console.log(`Fetching ${icao}: ${url}`);

  const response = await fetch(url, {
    headers: {
      'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
      'x-rapidapi-key': key,
    },
    timeout: 15000,
  });

  console.log(`AeroDataBox response for ${icao}: ${response.status}`);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} for ${icao}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  const departures = (data.departures || []).map((f) => mapFlight(f, 'departure'));
  const arrivals = (data.arrivals || []).map((f) => mapFlight(f, 'arrival'));

  console.log(`${icao}: ${departures.length} departures, ${arrivals.length} arrivals`);
  return [...departures, ...arrivals];
}

async function fetchAllFlights() {
  console.log('Fetch triggered at:', new Date().toISOString());

  const allFlights = [];
  const seen = new Set();

  for (const icao of AIRPORTS) {
    try {
      const flights = await fetchAirport(icao);
      for (const f of flights) {
        if (f.id && !seen.has(f.id + f.type)) {
          seen.add(f.id + f.type);
          allFlights.push(f);
        }
      }
    } catch (err) {
      fetchErrors++;
      console.error(`Error fetching ${icao}:`, err.message);
    }
    await sleep(2000); // 2-second delay between airports
  }

  flightCache = allFlights;
  lastUpdated = new Date().toISOString();
  nextRefresh = new Date(Date.now() + CACHE_TTL_MS).toISOString();
  console.log(`[${lastUpdated}] Cached ${allFlights.length} flights total`);
}

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    flights_cached: flightCache.length,
    last_updated: lastUpdated,
    next_refresh: nextRefresh,
    fetch_errors: fetchErrors,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// GET /flights
app.get('/flights', (_req, res) => {
  res.json({
    count: flightCache.length,
    last_updated: lastUpdated,
    next_refresh: nextRefresh,
    flights: flightCache,
  });
});

// GET /flights/:airport  — filter by origin or destination ICAO
app.get('/flights/:airport', (req, res) => {
  const target = req.params.airport.toUpperCase();
  const filtered = flightCache.filter(
    (f) => f.origin === target || f.destination === target
  );
  res.json({
    airport: target,
    count: filtered.length,
    last_updated: lastUpdated,
    flights: filtered,
  });
});

// Fetch on startup, then every 5 minutes
fetchAllFlights();
cron.schedule('*/5 * * * *', fetchAllFlights);

app.listen(PORT, () => {
  console.log(`Flyvia server running on port ${PORT}`);
});
