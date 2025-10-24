// index.js
// RezKyoo backend: conversational "mood" -> hybrid Places search -> call batches

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { Client: GoogleMapsClient } = require('@googlemaps/google-maps-services-js');

const app = express();
app.use(cors());
app.use(express.json());

/* ==================== Config ==================== */
const PORT = Number(process.env.PORT || 3000);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const gmaps = new GoogleMapsClient({});

const MAX_TEXTSEARCH_PAGES = 2;
const MIN_CANDIDATES = 12;
const CALLS_PER_BATCH = 5;

/* ==================== In-memory batches (replace with DB) ==================== */
const batches = new Map(); // batchId -> { id, status, query, restaurants, items: [] }

function newBatchId() {
  return 'batch_' + Math.random().toString(36).slice(2, 10);
}

async function createBatchAndStartCalls(restos, meta) {
  // TODO: Replace with your Telnyx/Twilio integration.
  // For now we just store a skeleton batch.
  const id = newBatchId();
  const items = restos.map(r => ({
    id: r.place_id,
    name: r.name,
    phone: r.formatted_phone_number || r.international_phone_number || '',
    status: 'pending', // 'in_progress' | 'completed' | 'error' | 'skipped' | 'machine_detected'
    result: null,
    raw: null
  }));
  batches.set(id, {
    id,
    status: 'in_progress',
    query: meta,
    restaurants: restos,
    items
  });

  // Example simulation (optional):
  // setTimeout(() => {
  //   const b = batches.get(id);
  //   if (!b) return;
  //   b.status = 'completed';
  //   b.items = b.items.map(x => ({ ...x, status: 'completed', result: { outcome: 'unavailable' } }));
  //   batches.set(id, b);
  // }, 3000);

  return id;
}

async function getBatchContext(batchId) {
  return batches.get(batchId) || null;
}

/* ==================== Health ==================== */
app.get('/health', (_req, res) => res.json({ ok: true, at: Date.now() }));

/* ==================== NLP: mood -> normalized JSON + chips ==================== */
app.post('/nlp/parse_query', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'Missing text' });
    }

    const system = `Extract a normalized JSON of dining intent.
Return ONLY JSON with keys:
cuisines[], dishes[], attributes[], dietary[], vibe[], budget($|$$|$$$|$$$$|""), hard_excludes[], radius_km(number).
Infer conservatively; empty arrays if unknown; radius_km default 5.`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `User: """${text}"""` }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(resp.choices?.[0]?.message?.content || '{}');

    const chips = [
      ...new Set([
        ...(parsed.dishes || []),
        ...(parsed.cuisines || []),
        ...(parsed.attributes || []),
        ...(parsed.vibe || []),
        ...(parsed.budget ? [parsed.budget] : []),
        ...(parsed.hard_excludes || []).map(x => `not ${x}`)
      ].filter(Boolean))
    ];

    res.json({ ok: true, parsed, chips });
  } catch (err) {
    console.error('parse_query error', err);
    res.status(500).json({ ok: false, error: 'NLP parse failed' });
  }
});

/* ==================== Google Places helpers ==================== */

// Small starter map; expand as you like.
const CUISINE_SIBLINGS = {
  asian: ['thai', 'chinese', 'japanese', 'korean', 'vietnamese', 'southeast asian', 'ramen', 'szechuan'],
  thai: ['asian', 'southeast asian', 'ramen'],
  chinese: ['asian', 'szechuan', 'noodles', 'ramen'],
  szechuan: ['chinese', 'asian'],
  ramen: ['japanese', 'asian', 'noodles'],
};

function synthesizeQueries(parsed) {
  const cuisines = new Set((parsed?.cuisines || []).map(s => s.toLowerCase()));
  for (const c of [...cuisines]) {
    (CUISINE_SIBLINGS[c] || []).forEach(x => cuisines.add(x));
  }
  const dishes = (parsed?.dishes || []).slice(0, 3).map(s => s.toLowerCase());
  const q = [
    ...[...cuisines].map(c => `${c} restaurant`),
    ...dishes.map(d => `${d} restaurant`),
    ...dishes
  ].filter(Boolean);
  return [...new Set(q)];
}

function isRestaurantType(types = []) {
  const t = types.map(x => (x || '').toLowerCase());
  return t.includes('restaurant') || t.includes('food') || t.includes('bar');
}
function isFastFoodOrTakeaway(types = []) {
  const t = types.map(x => (x || '').toLowerCase());
  return t.includes('fast_food') || t.includes('meal_takeaway') || t.includes('meal_delivery');
}
function hasPhone(p) {
  return !!(p.formatted_phone_number || p.international_phone_number);
}
function isOperational(p) {
  return (p.business_status || '').toUpperCase() === 'OPERATIONAL' || !p.business_status;
}

// REAL hours checker (supports specific time & "next available")
function isOpenAt(place, dateISO, timeHHMM, intent = 'specific_time') {
  const oh = place?.opening_hours;
  if (!oh || !Array.isArray(oh.periods) || !oh.periods.length) {
    // No hours info — allow it through (we'll still call), or change to false to exclude.
    return true;
  }

  if (intent === 'next_available' && typeof oh.open_now === 'boolean') {
    return oh.open_now === true;
  }

  const reqDate = new Date(`${dateISO}T${timeHHMM || '00:00'}:00`);
  const reqDay = reqDate.getDay(); // 0 (Sun) .. 6 (Sat)
  const [h, m] = (timeHHMM || '00:00').split(':').map(Number);
  const reqMinutes = h * 60 + m;

  const toMin = (hm) => {
    const str = String(hm).padStart(4, '0');
    const hh = Number(str.slice(0, 2));
    const mm = Number(str.slice(2, 4));
    if (str === '2400') return 24 * 60; // normalize 24:00 to 1440
    return hh * 60 + mm;
  };

  const intervals = [];
  for (const p of oh.periods) {
    const o = p.open, c = p.close;
    if (!o) continue;

    const openDay = Number(o.day);
    const openMin = toMin(o.time);

    let closeDay = openDay;
    let closeMin = 24 * 60;
    if (c && c.time) {
      closeDay = Number(c.day);
      closeMin = toMin(c.time);
    }

    if (openDay === closeDay) {
      if (openDay === reqDay) intervals.push([openMin, closeMin]);
    } else {
      // crosses midnight
      if (openDay === reqDay) intervals.push([openMin, 24 * 60]);
      if (closeDay === reqDay) intervals.push([0, closeMin]);
    }
  }

  if (!intervals.length) return false;
  if (intent === 'specific_time') {
    return intervals.some(([s, e]) => reqMinutes >= s && reqMinutes < e);
  }
  return true;
}

// Simple keyword score against reviews (0..1)
function keywordScore(reviews = [], craving = {}) {
  const positives = new Set([
    ...(craving?.chips || []),
    ...(craving?.parsed?.dishes || []),
    ...(craving?.parsed?.attributes || []),
    ...(craving?.parsed?.cuisines || [])
  ]
    .map(s => (s || '').toLowerCase())
    .filter(s => s && !s.startsWith('not '))
  );

  if (!positives.size) return 0;

  const text = reviews.map(r => (r?.text || '').toLowerCase()).join(' ');
  let hits = 0;
  positives.forEach(n => { if (text.includes(n)) hits++; });

  return Math.min(1, hits / Math.max(positives.size, 1));
}

// Scoring with a small penalty for unknown hours and soft boost for "reservable"
function combineScore(p, cravingScore) {
  const rating = Number(p.rating || 0);                    // 0..5
  const count = Number(p.user_ratings_total || 0);
  const normRating = Math.max(0, Math.min(1, (rating - 3.5) / 1.5)); // 3.5→0, 5.0→1
  const pop = Math.min(1, Math.log1p(count) / Math.log(1000));       // ~0..1
  const reserveBoost = p.reservable === true ? 0.1 : 0;

  const hasHours = !!p.opening_hours;
  const hoursPenalty = hasHours ? 0 : -0.08; // small nudge down if hours unknown

  return 0.55 * cravingScore + 0.25 * normRating + 0.10 * pop + reserveBoost + hoursPenalty;
}

async function textSearchMulti(queries, location, radiusMeters, apiKey) {
  const out = new Map(); // place_id -> summary
  for (const query of queries) {
    let page = 0;
    let pagetoken = undefined;
    do {
      const resp = await gmaps.textSearch({
        params: {
          query,
          location,     // {lat, lng} OR "lat,lng"
          radius: radiusMeters,
          key: apiKey,
          pagetoken
        }
      });
      const results = resp.data?.results || [];
      for (const r of results) {
        if (!out.has(r.place_id)) {
          out.set(r.place_id, {
            place_id: r.place_id,
            name: r.name,
            rating: r.rating,
            user_ratings_total: r.user_ratings_total,
            types: r.types || [],
            business_status: r.business_status,
          });
        }
      }
      pagetoken = resp.data?.next_page_token;
      page++;
    } while (pagetoken && page < MAX_TEXTSEARCH_PAGES);
  }
  return [...out.values()];
}

async function hydrateDetails(placeIds, apiKey) {
  const detailed = [];
  for (const pid of placeIds) {
    try {
      const resp = await gmaps.placeDetails({
        params: {
          place_id: pid,
          key: apiKey,
          fields: [
            'place_id','name','types','business_status',
            'formatted_phone_number','international_phone_number',
            'opening_hours','price_level','rating','user_ratings_total',
            'editorial_summary','reviews','reservable'
          ].join(',')
        }
      });
      if (resp.data?.result) detailed.push(resp.data.result);
    } catch (_e) {
      // ignore failed details
    }
  }
  return detailed;
}

async function findRestaurantsHybrid({ craving, center, date, time, intent, radiusKm = 5 }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('Missing GOOGLE_MAPS_API_KEY');

  const radiusStepsKm = [radiusKm, radiusKm + 4, radiusKm + 8];
  let results = [];
  const parsed = craving?.parsed || {};
  let queries = synthesizeQueries(parsed);
  if (!queries.length) queries = ['restaurant'];

  for (let step = 0; step < radiusStepsKm.length && results.length < MIN_CANDIDATES; step++) {
    const radiusM = Math.round(radiusStepsKm[step] * 1000);

    const candidates = await textSearchMulti(queries, center, radiusM, apiKey);
    const detailed = await hydrateDetails(candidates.map(c => c.place_id), apiKey);

    const eligible = detailed.filter(p =>
      isOperational(p) &&
      isRestaurantType(p.types) &&
      !isFastFoodOrTakeaway(p.types) &&
      hasPhone(p) &&
      isOpenAt(p, date, time, intent)
    );

    const scored = eligible.map(p => {
      const crave = keywordScore(p.reviews || [], craving);
      return { ...p, cravingScore: crave, finalScore: combineScore(p, crave) };
    });

    results = [...results, ...scored]
      .sort((a, b) => b.finalScore - a.finalScore)
      .filter((v, i, arr) => arr.findIndex(x => x.place_id === v.place_id) === i)
      .slice(0, 40);
  }

  return results;
}

/* ==================== Core endpoints ==================== */

// Start a new search + call batch (returns 5 to call)
app.post('/restaurants/search_and_call', async (req, res) => {
  try {
    const {
      cuisine, location, party_size, date, time, intent, craving
    } = req.body || {};

    if (!location) return res.status(400).json({ message: 'Missing location' });
    if (!party_size) return res.status(400).json({ message: 'Missing party_size' });
    if (!date) return res.status(400).json({ message: 'Missing date' });
    if (intent === 'specific_time' && !time) {
      return res.status(400).json({ message: 'Missing time for specific_time intent' });
    }

    // Geocode location to center
    const geo = await gmaps.geocode({
      params: { address: location, key: process.env.GOOGLE_MAPS_API_KEY }
    });
    const center = geo.data?.results?.[0]?.geometry?.location;
    if (!center) return res.status(400).json({ message: 'Could not geocode location' });

    // Find candidates using hybrid method
    const restaurants = await findRestaurantsHybrid({
      craving,
      center,
      date,
      time,
      intent,
      radiusKm: craving?.parsed?.radius_km || 5
    });

    const toCall = restaurants.slice(0, CALLS_PER_BATCH);

    const batchId = await createBatchAndStartCalls(toCall, {
      cuisine, location, party_size, date, time, intent, craving
    });

    // Optional: build a static map URL if you have it implemented
    const mapUrl = null;

    res.json({
      batchId,
      mapUrl,
      restaurants: toCall.map(p => ({
        id: p.place_id,
        place_id: p.place_id,
        name: p.name,
        rating: p.rating,
        user_ratings_total: p.user_ratings_total,
        formatted_phone_number: p.formatted_phone_number || p.international_phone_number || '',
        price_level: p.price_level
      })),
      query: { cuisine, location, party_size, date, time, intent, craving }
    });
  } catch (err) {
    console.error('search_and_call error', err);
    res.status(500).json({ message: 'Internal error starting search' });
  }
});

// Continue searching (avoid duplicates; return next 5)
app.post('/restaurants/search_more', async (req, res) => {
  try {
    const { original_batch_id, craving } = req.body || {};
    if (!original_batch_id) return res.status(400).json({ message: 'Missing original_batch_id' });

    const prev = await getBatchContext(original_batch_id);
    if (!prev) return res.status(404).json({ message: 'Original batch not found' });

    const { location, party_size, date, time, intent, cuisine } = prev.query;

    const geo = await gmaps.geocode({
      params: { address: location, key: process.env.GOOGLE_MAPS_API_KEY }
    });
    const center = geo.data?.results?.[0]?.geometry?.location;
    if (!center) return res.status(400).json({ message: 'Could not geocode location' });

    const restaurants = await findRestaurantsHybrid({
      craving,
      center,
      date,
      time,
      intent,
      radiusKm: craving?.parsed?.radius_km || 7 // widen a bit
    });

    const calledIds = new Set(prev.restaurants.map(r => r.place_id));
    const fresh = restaurants.filter(r => !calledIds.has(r.place_id)).slice(0, CALLS_PER_BATCH);

    const batchId = await createBatchAndStartCalls(fresh, {
      cuisine, location, party_size, date, time, intent, craving
    });

    const mapUrl = null;

    res.json({
      batchId,
      mapUrl,
      restaurants: fresh.map(p => ({
        id: p.place_id,
        place_id: p.place_id,
        name: p.name,
        rating: p.rating,
        user_ratings_total: p.user_ratings_total,
        formatted_phone_number: p.formatted_phone_number || p.international_phone_number || '',
        price_level: p.price_level
      })),
      query: prev.query
    });
  } catch (err) {
    console.error('search_more error', err);
    res.status(500).json({ message: 'Internal error finding more restaurants' });
  }
});

// Poll batch status (wire this to your real call pipeline)
app.get('/status/:batchId', async (req, res) => {
  const { batchId } = req.params;
  const batch = await getBatchContext(batchId);
  if (!batch) return res.status(404).json({ message: 'Batch not found' });

  res.json({
    ok: true,
    status: batch.status,  // 'in_progress' | 'completed'
    items: batch.items     // each: { id, name, phone, status, result, raw }
  });
});

/* ==================== Start server ==================== */
app.listen(PORT, () => {
  console.log(`✅ RezKyoo server running on http://localhost:${PORT}`);
});
