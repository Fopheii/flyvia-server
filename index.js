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
  const results = await Promise.allSettled(
    ZONES.map((zone, i) =>
      fetchZone(`https://opensky-network.org/api/states/all?${zone}`)
        .catch(err => { console.log(`Zone ${i} failed:`, err.message); return null; })
    )
  );

  let allStates = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value?.states) {
      allStates = allStates.concat(result.value.states);
    }
  });

  console.log('Total raw states across all zones:', allStates.length);

  const flights = allStates
    .filter(s => s[0]?.trim() && s[6] && s[5] && !s[8])
    .map(mapFlight)
    .filter(f => f.id);

  cachedFlights = flights;
  lastUpdated = new Date().toISOString();
  console.log(`[${lastUpdated}] Cached ${flights.length} flights`);
}

cron.schedule('*/30 * * * * *', fetchAllFlights);
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
  res.json({
    count: cachedFlights.length,
    last_updated: lastUpdated,
    flights: cachedFlights
  });
});

app.listen(PORT, () => {
  console.log(`Flyvia server running on port ${PORT}`);
});
