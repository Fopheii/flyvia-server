const express = require('express');
const fetch   = require('node-fetch');
const https   = require('https');
const cron    = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

// ── Credentials ───────────────────────────────────────────────────────────────
const AERODATABOX_KEY  = process.env.AERODATABOX_KEY;
const OPENSKY_USERNAME = process.env.OPENSKY_USERNAME;
const OPENSKY_PASSWORD = process.env.OPENSKY_PASSWORD;

// ── Config ────────────────────────────────────────────────────────────────────
const AIRPORTS = [
  'KJFK', 'KMIA', 'KLAX', 'KATL', 'KORD',
  'MDSD', 'MDPC', 'MDST',
  'TJSJ',
  'MMMX', 'MMUN',
  'SKBO',
  'SBGR',
  'CYYZ',
  'LEMD',
  'EGLL',
];

const OPENSKY_ZONES = [
  'lamin=-60&lamax=90&lomin=-180&lomax=-60',
  'lamin=-60&lamax=90&lomin=-60&lomax=0',
  'lamin=-60&lamax=90&lomin=0&lomax=60',
  'lamin=-60&lamax=90&lomin=60&lomax=180',
];

// Airport coords for estimated positioning on unmatched flights
const AIRPORT_COORDS = {
  KJFK: { lat: 40.6413,  lon: -73.7781  },
  KMIA: { lat: 25.7959,  lon: -80.2870  },
  KLAX: { lat: 33.9425,  lon: -118.4081 },
  KATL: { lat: 33.6407,  lon: -84.4277  },
  KORD: { lat: 41.9742,  lon: -87.9073  },
  MDSD: { lat: 18.4297,  lon: -69.6689  },
  MDPC: { lat: 18.5674,  lon: -68.3634  },
  MDST: { lat: 19.4061,  lon: -70.6047  },
  TJSJ: { lat: 18.4394,  lon: -66.0018  },
  MMMX: { lat: 19.4363,  lon: -99.0721  },
  MMUN: { lat: 21.0365,  lon: -86.8771  },
  SKBO: { lat:  4.7016,  lon: -74.1469  },
  SBGR: { lat: -23.4356, lon: -46.4731  },
  CYYZ: { lat: 43.6777,  lon: -79.6248  },
  LEMD: { lat: 40.4936,  lon:  -3.5668  },
  EGLL: { lat: 51.4775,  lon:  -0.4614  },
};

// ── State ─────────────────────────────────────────────────────────────────────
let cachedFlights = [];
let lastUpdated   = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toMs(timeObj) {
  if (!timeObj) return null;
  const raw = timeObj.utc ?? timeObj.local;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return isNaN(ms) ? null : ms;
}

function bearing(dep, arr) {
  const dLon = (arr.lon - dep.lon) * Math.PI / 180;
  const φ1   = dep.lat * Math.PI / 180;
  const φ2   = arr.lat * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function estimatePosition(depIcao, arrIcao, depMs, arrMs) {
  const dep = AIRPORT_COORDS[depIcao];
  const arr = AIRPORT_COORDS[arrIcao];
  if (!dep || !arr || !depMs || !arrMs) return null;
  const now = Date.now();
  if (now <= depMs || now >= arrMs) return null;
  const t = (now - depMs) / (arrMs - depMs);
  return {
    lat:     dep.lat + (arr.lat - dep.lat) * t,
    lon:     dep.lon + (arr.lon - dep.lon) * t,
    heading: Math.round(bearing(dep, arr)),
  };
}

// ── AeroDataBox ───────────────────────────────────────────────────────────────
async function fetchAirportDepartures(icao) {
  if (!AERODATABOX_KEY) throw new Error('AERODATABOX_KEY not set');

  const from = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6 h ago
  const to   = new Date(Date.now() + 0.5 * 60 * 60 * 1000); // +30 min
  const fmt  = d => d.toISOString().slice(0, 16);

  const url =
    `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${icao}` +
    `/${fmt(from)}/${fmt(to)}` +
    `?withLeg=true&withCancelled=false&withCodeshared=false` +
    `&withCargo=false&withPrivate=false&withLocation=false&direction=Departure`;

  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key':  AERODATABOX_KEY,
      'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
    },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAllAeroDataBox() {
  console.log(`\n[ADB] Fetching ${AIRPORTS.length} airports`);
  const flightMap = new Map(); // callsign → flight metadata

  for (let i = 0; i < AIRPORTS.length; i++) {
    const icao = AIRPORTS[i];
    try {
      const data       = await fetchAirportDepartures(icao);
      const departures = data.departures ?? [];

      for (const f of departures) {
        const callsign = f.callSign?.trim();
        if (!callsign) continue;

        // Skip flights clearly on the ground or cancelled
        const status = f.status ?? '';
        if (['Cancelled', 'Diverted', 'Landed'].includes(status)) continue;

        const depMs = toMs(f.departure?.actualTime) ?? toMs(f.departure?.scheduledTime);
        const arrMs = toMs(f.arrival?.scheduledTime);

        // Skip if departure is still in the future
        if (depMs && depMs > Date.now()) continue;

        flightMap.set(callsign, {
          callsign,
          airline:  f.airline?.name                              ?? null,
          from:     f.departure?.airport?.iata ?? f.departure?.airport?.icao ?? null,
          to:       f.arrival?.airport?.iata   ?? f.arrival?.airport?.icao   ?? null,
          depIcao:  f.departure?.airport?.icao ?? null,
          arrIcao:  f.arrival?.airport?.icao   ?? null,
          depMs,
          arrMs,
        });
      }

      console.log(`[ADB] ${icao}: ${departures.length} departures | map: ${flightMap.size}`);
    } catch (e) {
      console.log(`[ADB] ${icao} failed:`, e.message);
    }

    if (i < AIRPORTS.length - 1) await sleep(2000);
  }

  console.log(`[ADB] Done — ${flightMap.size} unique callsigns`);
  return flightMap;
}

// ── OpenSky ───────────────────────────────────────────────────────────────────
async function fetchOpenSkyZone(url) {
  const headers = {};
  if (OPENSKY_USERNAME && OPENSKY_PASSWORD) {
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${OPENSKY_USERNAME}:${OPENSKY_PASSWORD}`).toString('base64');
  }
  const res = await fetch(url, { headers, agent: httpsAgent, timeout: 15000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchAllOpenSky() {
  console.log(`[OpenSky] Fetching ${OPENSKY_ZONES.length} zones`);
  const stateMap = new Map(); // callsign → raw state array

  for (let i = 0; i < OPENSKY_ZONES.length; i++) {
    const url = `https://opensky-network.org/api/states/all?${OPENSKY_ZONES[i]}`;
    try {
      const data = await fetchOpenSkyZone(url);
      if (data?.states) {
        for (const s of data.states) {
          const cs = s[0]?.trim();
          if (cs && s[5] != null && s[6] != null) stateMap.set(cs, s);
        }
        console.log(`[OpenSky] Zone ${i}: ${data.states.length} states`);
      }
    } catch (e) {
      console.log(`[OpenSky] Zone ${i} failed:`, e.message);
    }

    if (i < OPENSKY_ZONES.length - 1) await sleep(15000);
  }

  console.log(`[OpenSky] Done — ${stateMap.size} unique callsigns`);
  return stateMap;
}

// ── Build flight list from AeroDataBox map ────────────────────────────────────
function buildFlightsFromAdb(flightMap, stateMap = new Map()) {
  const flights = [];
  let gpsMatches = 0, estimated = 0;

  for (const [callsign, flight] of flightMap) {
    const state = stateMap.get(callsign);

    let lat, lon, altitude, speed, heading;

    if (state) {
      if (state[8]) continue;                                    // on_ground — skip
      lat      = state[6];
      lon      = state[5];
      altitude = state[7] ? Math.round(state[7] * 3.28084) : 0; // m → ft
      speed    = state[9] ? Math.round(state[9] * 1.94384) : 0; // m/s → knots
      heading  = state[10] ? Math.round(state[10]) : 0;
      gpsMatches++;
    } else {
      // Estimate position from route progress
      const est = estimatePosition(flight.depIcao, flight.arrIcao, flight.depMs, flight.arrMs);
      if (!est) continue;
      lat      = est.lat;
      lon      = est.lon;
      altitude = 35000; // cruise assumption (ft)
      speed    = 480;   // cruise assumption (knots)
      heading  = est.heading;
      estimated++;
    }

    flights.push({
      id:        callsign,
      callsign,
      lat,
      lon,
      altitude,
      speed,
      heading,
      on_ground: false,
      from:      flight.from,
      to:        flight.to,
      airline:   flight.airline,
    });
  }

  console.log(`[Build] ${flights.length} flights — ${gpsMatches} GPS matched, ${estimated} estimated`);
  return flights;
}

// ── Merge & cache ─────────────────────────────────────────────────────────────
async function fetchAndMerge() {
  console.log('\n[Cycle] Starting at', new Date().toISOString());

  // Step 1 — AeroDataBox (routes + airline names)
  const flightMap = await fetchAllAeroDataBox();

  // Cache immediately after AeroDataBox — don't wait for OpenSky
  const adbFlights = buildFlightsFromAdb(flightMap);
  if (adbFlights.length > 0) {
    cachedFlights = adbFlights;
    lastUpdated   = new Date().toISOString();
    console.log(`[ADB] Cached ${cachedFlights.length} flights immediately`);
  } else {
    console.log('[ADB] No flights built — keeping existing cache of', cachedFlights.length);
  }

  // Step 2 — OpenSky (optional GPS enrichment — if it fails, ADB cache stays)
  try {
    const stateMap = await fetchAllOpenSky();
    const enriched = buildFlightsFromAdb(flightMap, stateMap);
    if (enriched.length > 0) {
      cachedFlights = enriched;
      lastUpdated   = new Date().toISOString();
      console.log(`[OpenSky] Cache enriched → ${cachedFlights.length} flights with GPS`);
    }
  } catch (e) {
    console.log('[OpenSky] Failed — keeping AeroDataBox cache:', e.message);
  }
}

// ── Schedule: every 5 minutes ─────────────────────────────────────────────────
cron.schedule('*/5 * * * *', fetchAndMerge);
fetchAndMerge();

// ── HTTP ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    flights_cached: cachedFlights.length,
    last_updated:   lastUpdated,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/flights', (req, res) => {
  const limit   = req.query.limit ? parseInt(req.query.limit, 10) : null;
  const flights = limit > 0 ? cachedFlights.slice(0, limit) : cachedFlights;
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
