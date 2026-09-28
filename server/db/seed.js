/**
 * Demo data.
 *
 * Positions are interpolated along real corridors from the highway graph, so
 * a seeded pothole actually sits on the Lagos–Ibadan Expressway rather than in
 * a random field. Run with `npm run seed` (or `npm run reset` to wipe first).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from './index.js';
import { placesById } from '../services/gazetteer.js';
import { REPORT_TYPES } from '../services/taxonomy.js';
import { roadAt } from '../services/reports.js';
import { describe, nearest } from '../services/gazetteer.js';

const HOUR = 3600_000;

/** A point `t` of the way from place `a` to place `b`, nudged off-centre. */
function between(a, b, t, jitter = 0.004) {
  const pa = placesById.get(a);
  const pb = placesById.get(b);
  if (!pa || !pb) throw new Error(`Unknown seed place: ${a} / ${b}`);
  const wobble = (Math.sin((t + 1) * 97.13) * jitter) / 2;
  return {
    lat: pa.lat + (pb.lat - pa.lat) * t + wobble,
    lon: pa.lon + (pb.lon - pa.lon) * t - wobble,
  };
}

const SEEDS = [
  // ---- Lagos–Ibadan corridor -------------------------------------------
  { type: 'gridlock', at: between('berger', 'sagamu', 0.18), label: 'Kara bridge', note: 'Standstill from the cattle market down to the bridge. Budget an extra 40 minutes.', hoursAgo: 1.2, confirms: 6 },
  { type: 'pothole', at: between('berger', 'sagamu', 0.52), label: 'Outbound carriageway', note: 'Three deep craters in the middle lane just after the trailer park. Trucks are swerving.', hoursAgo: 30, confirms: 9 },
  { type: 'construction', at: between('sagamu', 'ibadan', 0.44), label: 'Ogunmakin section', note: 'Single lane working, flagmen on site from 7am.', hoursAgo: 96, confirms: 4 },
  { type: 'accident', at: between('sagamu', 'ibadan', 0.71), label: 'Near Ogere', note: 'Articulated truck lost its container across two lanes. FRSC on scene.', hoursAgo: 2.5, confirms: 5 },
  { type: 'fuel_available', at: between('sagamu', 'ibadan', 0.3), label: 'NNPC Mega Station, Ogere', meta: { price: 1025, brand: 'NNPC', queue: 'short', product: 'petrol' }, hoursAgo: 4, confirms: 3 },
  { type: 'clear', at: between('berger', 'sagamu', 0.85), label: 'Sagamu interchange', note: 'Free flow this morning.', hoursAgo: 3 },

  // ---- Lagos metro -------------------------------------------------------
  { type: 'flooding', at: between('oshodi', 'mile2', 0.4), label: 'Apapa–Oshodi Expressway', note: 'Knee-deep water at the service lane after last night rain. Keep to the outer lane.', hoursAgo: 8, confirms: 7 },
  { type: 'gridlock', at: between('apapa', 'mile2', 0.35), label: 'Tin Can approach', note: 'Tanker queue back to Coconut. Avoid unless you are going to the port.', hoursAgo: 0.6, confirms: 11 },
  { type: 'pothole', at: between('iyana-ipaja', 'ota', 0.3), label: 'Abeokuta Expressway', note: 'Bad patch under the bridge, slow right down at night.', hoursAgo: 240, confirms: 5 },
  { type: 'fuel_out', at: between('ikeja', 'oshodi', 0.5), label: 'Station on Agege Motor Road', meta: { brand: 'Independent' }, hoursAgo: 5, confirms: 2 },
  { type: 'fuel_available', at: between('victoria-island', 'lekki', 0.42), label: 'Mobil, Lekki Phase 1', meta: { price: 1080, brand: 'Mobil', queue: 'none' }, hoursAgo: 2, confirms: 4 },
  { type: 'checkpoint', at: between('ajah', 'epe', 0.36), label: 'Police checkpoint', note: 'Routine stop, moving quickly.', hoursAgo: 6, confirms: 2 },
  { type: 'closed', at: { lat: 6.4415, lon: 3.4205 }, label: 'Old bank branch, Awolowo Road', note: 'Branch shut down last year, the building is empty now.', hoursAgo: 1200 },

  // ---- Benin / Ore corridor ---------------------------------------------
  { type: 'security', at: between('ijebu-ode', 'ore', 0.62), label: 'Forested stretch before Ore', note: 'Two separate robbery attempts reported at dusk this week. Do not travel this section after 6pm.', hoursAgo: 20, confirms: 14 },
  { type: 'pothole', at: between('ore', 'benin-city', 0.28), label: 'Ofosu axis', note: 'Surface completely failed for about 2 km. Heavy vehicles crawling.', hoursAgo: 60, confirms: 8 },
  { type: 'fuel_available', at: between('ore', 'benin-city', 0.55), label: 'Total, Ofosu', meta: { price: 1045, brand: 'Total', queue: 'moderate' }, hoursAgo: 9, confirms: 2 },
  { type: 'gridlock', at: between('ore', 'benin-city', 0.9), label: 'Benin bypass', note: 'Diversion traffic building up from the ring road.', hoursAgo: 1.8, confirms: 3 },

  // ---- Abuja / North Central ---------------------------------------------
  { type: 'security', at: between('zuba', 'jere', 0.55), label: 'Abuja–Kaduna Expressway', note: 'Armed activity reported around Katari at night. Convoy travel advised, daytime only.', hoursAgo: 14, confirms: 18 },
  { type: 'checkpoint', at: between('jere', 'kaduna', 0.3), label: 'Military checkpoint', note: 'Thorough checks, have your ID ready.', hoursAgo: 7, confirms: 6 },
  { type: 'pothole', at: between('gwagwalada', 'koton-karfe', 0.4), label: 'Abuja–Lokoja Road', note: 'Failed section either side of the bridge.', hoursAgo: 150, confirms: 6 },
  { type: 'construction', at: between('koton-karfe', 'lokoja', 0.6), label: 'Dualisation works', note: 'Contractor active, traffic on one carriageway.', hoursAgo: 300, confirms: 3 },
  { type: 'fuel_available', at: between('gwagwalada', 'koton-karfe', 0.15), label: 'NNPC, Gwagwalada', meta: { price: 1015, brand: 'NNPC', queue: 'long' }, hoursAgo: 3, confirms: 5 },
  { type: 'fuel_out', at: between('koton-karfe', 'lokoja', 0.8), label: 'Station before Lokoja', meta: { brand: 'Independent' }, hoursAgo: 6, confirms: 3 },
  { type: 'gridlock', at: between('abuja', 'nyanya', 0.5), label: 'Nyanya inbound', note: 'Usual morning crawl, worse today.', hoursAgo: 1, confirms: 4 },
  { type: 'clear', at: between('abuja-airport', 'gwagwalada', 0.5), label: 'Airport road', note: 'Moving well.', hoursAgo: 2 },

  // ---- South East ---------------------------------------------------------
  { type: 'flooding', at: between('onitsha', 'awka', 0.25), label: 'Upper Iweka approach', note: 'Drainage overflowed, water across both lanes. Trucks stuck.', hoursAgo: 5, confirms: 9 },
  { type: 'pothole', at: between('okigwe', 'enugu', 0.45), label: 'Enugu–Okigwe Expressway', note: 'Long stretch of broken surface, single file in places.', hoursAgo: 72, confirms: 7 },
  { type: 'protest', at: between('aba', 'port-harcourt', 0.3), label: 'Union road block', note: 'Transport union protest, road blocked both directions since morning.', hoursAgo: 4, confirms: 8 },
  { type: 'fuel_available', at: between('owerri', 'port-harcourt', 0.4), label: 'Oando, Elele', meta: { price: 1060, brand: 'Oando', queue: 'short' }, hoursAgo: 7, confirms: 2 },
  { type: 'accident', at: between('onitsha', 'asaba', 0.5), label: 'Niger Bridge', note: 'Minor collision on the bridge, one lane blocked.', hoursAgo: 1.5, confirms: 4 },
  { type: 'relocated', at: { lat: 6.2185, lon: 7.0721 }, label: 'Government office, Awka', note: 'Moved to the new secretariat on the bypass.', hoursAgo: 800 },

  // ---- South South ---------------------------------------------------------
  { type: 'pothole', at: between('ahoada', 'yenagoa', 0.5), label: 'East–West Road', note: 'Severe potholes for several kilometres, expect long delays.', hoursAgo: 120, confirms: 11 },
  { type: 'flooding', at: between('yenagoa', 'patani', 0.45), label: 'Patani axis', note: 'Seasonal flooding, water rising again this week.', hoursAgo: 26, confirms: 6 },
  { type: 'fuel_available', at: between('port-harcourt', 'ahoada', 0.2), label: 'Conoil, Rumuokoro', meta: { price: 1070, brand: 'Conoil', queue: 'moderate' }, hoursAgo: 5, confirms: 3 },
  { type: 'checkpoint', at: between('uyo', 'calabar', 0.4), label: 'Itu bridge checkpoint', hoursAgo: 9, confirms: 2 },

  // ---- North West / North East ---------------------------------------------
  { type: 'security', at: between('kaduna', 'birnin-gwari', 0.5), label: 'Birnin Gwari road', note: 'Well-known high-risk corridor. Travel only in daylight, preferably with a convoy.', hoursAgo: 40, confirms: 22 },
  { type: 'checkpoint', at: between('zaria', 'kano', 0.55), label: 'Army checkpoint', hoursAgo: 11, confirms: 3 },
  { type: 'pothole', at: between('potiskum', 'damaturu', 0.4), label: 'Damaturu highway', note: 'Broken edges, keep to the centre.', hoursAgo: 200, confirms: 4 },
  { type: 'fuel_available', at: between('kaduna', 'zaria', 0.3), label: 'NNPC, Rigachikun', meta: { price: 1005, brand: 'NNPC', queue: 'short' }, hoursAgo: 8, confirms: 4 },
  { type: 'fuel_out', at: between('bauchi', 'jos', 0.5), label: 'Station on Bauchi–Jos Road', hoursAgo: 12, confirms: 2 },
  { type: 'construction', at: between('jos', 'bauchi', 0.2), label: 'Bridge repair', note: 'Temporary diversion in place.', hoursAgo: 400, confirms: 3 },
  { type: 'clear', at: between('kano', 'katsina', 0.5), label: 'Kano–Katsina Road', note: 'Good surface, quick run.', hoursAgo: 6 },

  // ---- Middle belt ----------------------------------------------------------
  { type: 'obstruction', at: between('lokoja', 'okene', 0.35), label: 'Broken-down trailer', note: 'Blocking the inside lane on the climb.', hoursAgo: 3, confirms: 4 },
  { type: 'pothole', at: between('okene', 'auchi', 0.5), label: 'Okene–Auchi Road', note: 'Rough for about 5 km.', hoursAgo: 90, confirms: 5 },
  { type: 'security', at: between('makurdi', 'otukpo', 0.45), label: 'Otukpo road', note: 'Avoid after dark, incidents reported this month.', hoursAgo: 55, confirms: 7 },
  { type: 'fuel_available', at: between('lafia', 'makurdi', 0.35), label: 'Ardova, Doma junction', meta: { price: 1050, brand: 'Ardova', queue: 'none' }, hoursAgo: 10, confirms: 1 },
  { type: 'renamed', at: { lat: 8.4949, lon: 8.5167 }, label: 'Old market square, Lafia', note: 'Now called the new central market.', hoursAgo: 900 },

  // ---- West -----------------------------------------------------------------
  { type: 'pothole', at: between('ibadan', 'oyo', 0.4), label: 'Ibadan–Oyo Road', note: 'Patchy surface around Akinyele.', hoursAgo: 130, confirms: 4 },
  { type: 'flooding', at: between('ibadan', 'ile-ife', 0.3), label: 'Ife road', note: 'Water across the road after heavy rain.', hoursAgo: 18, confirms: 3 },
  { type: 'fuel_available', at: between('ogbomoso', 'ilorin', 0.5), label: 'Total, Oyo–Ilorin Road', meta: { price: 1035, brand: 'Total', queue: 'short' }, hoursAgo: 6, confirms: 2 },
  { type: 'gridlock', at: between('ilorin', 'jebba', 0.15), label: 'Ilorin outbound', note: 'Market day traffic.', hoursAgo: 2.2, confirms: 2 },
  { type: 'accident', at: between('akure', 'owo', 0.5), label: 'Akure–Owo Road', note: 'Two vehicles involved, partially blocking.', hoursAgo: 3.5, confirms: 3 },
];

const REPORTERS = ['Chidi', 'Aisha', 'Tunde', 'Ngozi', 'Musa', 'Blessing', 'Emeka', 'Fatima', 'Segun', 'Ibrahim', 'Amara', 'Yemi'];

export function seedReports({ reset = false } = {}) {
  const db = getDb();
  if (reset) {
    db.exec('DELETE FROM reports; DELETE FROM report_votes; DELETE FROM trips; DELETE FROM trip_pings; DELETE FROM trip_events;');
  }

  const insert = db.prepare(
    `INSERT INTO reports
      (id, type, category, severity, lat, lon, label, note, road, place, state, device_id, reporter, meta, confirms, status, created_at, updated_at, expires_at)
     VALUES
      (@id, @type, @category, @severity, @lat, @lon, @label, @note, @road, @place, @state, @device_id, @reporter, @meta, @confirms, @status, @created_at, @updated_at, @expires_at)`,
  );

  const now = Date.now();
  let inserted = 0;

  const tx = db.transaction(() => {
    SEEDS.forEach((seed, i) => {
      const meta = REPORT_TYPES[seed.type];
      const createdAt = new Date(now - seed.hoursAgo * HOUR);
      const expiresAt = new Date(createdAt.getTime() + meta.ttlHours * HOUR * (seed.confirms ? 2 : 1));
      if (expiresAt.getTime() < now) return; // would already be stale — skip

      const [place] = nearest(seed.at.lat, seed.at.lon, { limit: 1 });
      insert.run({
        id: `seed_${String(i).padStart(3, '0')}_${randomUUID().slice(0, 6)}`,
        type: seed.type,
        category: meta.category,
        severity: seed.severity ?? meta.severity,
        lat: Number(seed.at.lat.toFixed(5)),
        lon: Number(seed.at.lon.toFixed(5)),
        label: seed.label ?? null,
        note: seed.note ?? null,
        road: roadAt(seed.at.lat, seed.at.lon),
        place: describe(seed.at.lat, seed.at.lon),
        state: place?.state ?? null,
        device_id: `seed_device_${i % 9}`,
        reporter: REPORTERS[i % REPORTERS.length],
        meta: seed.meta ? JSON.stringify(seed.meta) : null,
        confirms: seed.confirms ?? 0,
        status: 'active',
        created_at: createdAt.toISOString(),
        updated_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
      inserted += 1;
    });
  });
  tx();

  return inserted;
}

/** Only seeds when the table is empty — safe to call on every boot. */
export function ensureSeed() {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM reports').get();
  if (n > 0) return 0;
  return seedReports();
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const reset = process.argv.includes('--reset');
  const count = seedReports({ reset });
  process.stdout.write(`Seeded ${count} reports${reset ? ' (after reset)' : ''}.\n`);
}
