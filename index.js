const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true
});

let cachedFlights = [];
let lastUpdated = null;
let fetchErrors = 0;

const ZONES = [
  'lamin=-60&lamax=90&lomin=-180&lomax=-60',
  'lamin=-60&lamax=90&lomin=-60&lomax=0',
  'lamin=-60&lamax=90&lomin=0&lomax=60',
  'lamin=-60&lamax=90&lomin=60&lomax=180',
];

async function fetchZone(url) {
  const username = process.env.OPENSKY_USERNAME;
  const password = process.env.OPENSKY_PASSWORD;
  const headers = {};
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
    timeout: 15000
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function mapFlight(state) {
  return {
    id: state[0]?.trim(),
    callsign: state[0]?.trim(),
    country: state[2],
    lat: state[6],
    lon: state[5],
    altitude: state[7] ? Math.round(state[7] * 3.28084) : 0,
    speed: state[9] ? Math.round(state[9] * 1.94384) : 0,
    heading: state[10] ? Math.round(state[10]) : 0,
    on_ground: state[8],
  };
}

async function fetchAllFlights() {
  console.log('Cron job triggered at:', new Date().toISOString());

  let allStates = [];

  for (let i = 0; i < ZONES.length; i++) {
    const url = `https://opensky-network.org/api/states/all?${ZONES[i]}`;
    try {
      const data = await fetchZone(url);
      if (data?.states) {
        allStates = allStates.concat(data.states);
        console.log(`Zone ${i} OK: ${data.states.length} states`);
      }
    } catch (e) {
      console.log(`Zone ${i} failed:`, e.message);
    }

    // 10 s gap between zone requests to avoid rate limiting
    if (i < ZONES.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }

  console.log('Total raw states across all zones:', allStates.length);

  const flights = allStates
    .filter(s => s[0]?.trim() && s[6] && s[5] && !s[8])
    .map(mapFlight)
    .filter(f => f.id);

  // Only replace cache when we actually got data — never wipe on a bad run
  if (flights.length > 0) {
    cachedFlights = flights;
    lastUpdated = new Date().toISOString();
    console.log(`[${lastUpdated}] Cached ${flights.length} flights`);
  } else {
    console.log('No new flights — keeping existing cache of', cachedFlights.length);
  }
}

// Every 10 minutes — well within OpenSky's anonymous rate limit
cron.schedule('*/10 * * * *', fetchAllFlights);
fetchAllFlights();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    flights_cached: cachedFlights.length,
    last_updated: lastUpdated,
    fetch_errors: fetchErrors,
    uptime_seconds: Math.floor(process.uptime())
  });
});

app.get('/flights', (req, res) => {
  const limit   = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const flights = (limit && limit > 0) ? cachedFlights.slice(0, limit) : cachedFlights;
  res.json({
    count:        flights.length,
    total:        cachedFlights.length,
    last_updated: lastUpdated,
    flights,
  });
});

app.listen(PORT, () => {
  console.log(`Flyvia server running on port ${PORT}`);
});
