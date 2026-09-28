/**
 * Route intelligence — the feature that turns a map into advice.
 *
 * Takes a route geometry and the live report database, works out which
 * reports actually sit on the corridor you are going to drive, where along
 * the trip you will meet them, and how worried you should be.
 */

import { pointToPolyline, polylineLength, pointAlong } from './geo.js';
import { REPORT_TYPES } from './taxonomy.js';

/** Reports further than this from the line are somebody else's problem. */
const DEFAULT_CORRIDOR_M = 2000;
/** The offline network is a simplification, so widen the net a little. */
const OFFLINE_CORRIDOR_M = 6000;

const GRADES = [
  { min: 85, grade: 'clear', label: 'Clear run', tone: 'good' },
  { min: 68, grade: 'fair', label: 'Mostly fine', tone: 'good' },
  { min: 48, grade: 'caution', label: 'Drive with care', tone: 'warn' },
  { min: 28, grade: 'rough', label: 'Rough route', tone: 'bad' },
  { min: 0, grade: 'severe', label: 'Serious trouble reported', tone: 'bad' },
];

export function gradeFor(score) {
  return GRADES.find((g) => score >= g.min) ?? GRADES[GRADES.length - 1];
}

/**
 * @param {Array<[number,number]>} geometry
 * @param {Array<object>} reports  Already-hydrated report objects.
 * @param {{corridorM?:number, source?:string, durationS?:number, departAt?:Date}} [options]
 */
export function analyseRoute(geometry, reports, options = {}) {
  const corridorM = options.corridorM ?? (options.source === 'offline' ? OFFLINE_CORRIDOR_M : DEFAULT_CORRIDOR_M);
  const totalM = polylineLength(geometry);
  const totalKm = totalM / 1000;
  const durationS = options.durationS ?? (totalKm / 60) * 3600;

  const hazards = [];
  for (const report of reports) {
    const hit = pointToPolyline([report.lat, report.lon], geometry);
    if (hit.distance > corridorM) continue;
    const meta = REPORT_TYPES[report.type] ?? { weight: 1 };
    const alongFraction = totalM > 0 ? Math.min(1, hit.along / totalM) : 0;
    hazards.push({
      ...report,
      offRouteM: Math.round(hit.distance),
      alongM: Math.round(hit.along),
      alongPct: Math.round(alongFraction * 100),
      etaFromStartS: Math.round(durationS * alongFraction),
      weight: meta.weight ?? 1,
      onRoute: hit.distance <= corridorM * 0.35,
    });
  }
  hazards.sort((a, b) => a.alongM - b.alongM);

  let penalty = 0;
  let bonus = 0;
  for (const h of hazards) {
    const proximity = 1 - 0.55 * Math.min(1, h.offRouteM / corridorM);
    const impact = h.weight * Math.max(0.5, h.severity) * h.confidence * proximity * 3.4;
    if (h.weight < 0) bonus += Math.abs(impact);
    else penalty += impact;
  }

  // Normalise by trip length: five hazards on a 20 km hop is a nightmare,
  // five on a 700 km haul is a Tuesday.
  const lengthScale = Math.max(0.55, Math.min(2.4, Math.sqrt(320 / Math.max(12, totalKm))));
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty * lengthScale + Math.min(8, bonus))));
  const grade = gradeFor(score);

  const byCategory = {};
  for (const h of hazards) {
    if (h.weight <= 0) continue;
    byCategory[h.category] = (byCategory[h.category] ?? 0) + 1;
  }

  return {
    corridorM,
    score,
    grade: grade.grade,
    gradeLabel: grade.label,
    tone: grade.tone,
    hazardCount: hazards.filter((h) => h.weight > 0).length,
    byCategory,
    hazards,
    worstStretch: worstStretch(hazards, totalM, geometry),
    advisories: advisories(hazards, { totalKm, durationS, departAt: options.departAt, score }),
  };
}

/** The 40 km window carrying the most trouble. */
function worstStretch(hazards, totalM, geometry) {
  const real = hazards.filter((h) => h.weight > 0);
  if (real.length < 2 || totalM < 45000) return null;
  const windowM = 40000;
  let best = null;
  for (const anchor of real) {
    const start = anchor.alongM;
    const inside = real.filter((h) => h.alongM >= start && h.alongM <= start + windowM);
    if (inside.length < 2) continue;
    const weight = inside.reduce((sum, h) => sum + h.weight * h.severity * h.confidence, 0);
    if (!best || weight > best.weight) {
      best = {
        weight,
        count: inside.length,
        fromM: start,
        toM: Math.min(totalM, start + windowM),
        road: inside.find((h) => h.road)?.road ?? null,
        place: inside[0].place ?? null,
        midpoint: pointAlong(geometry, start + Math.min(windowM, totalM - start) / 2),
        types: [...new Set(inside.map((h) => h.type))],
      };
    }
  }
  if (!best) return null;
  return {
    count: best.count,
    fromKm: Math.round(best.fromM / 1000),
    toKm: Math.round(best.toM / 1000),
    road: best.road,
    place: best.place,
    midpoint: best.midpoint,
    types: best.types,
  };
}

function advisories(hazards, { totalKm, durationS, departAt, score }) {
  const out = [];
  const active = hazards.filter((h) => h.weight > 0);
  const count = (type) => active.filter((h) => h.type === type).length;
  const month = (departAt ?? new Date()).getMonth() + 1;

  const securityHits = active.filter((h) => h.category === 'security' && h.type !== 'checkpoint');
  if (securityHits.length) {
    out.push({
      level: 'high',
      title: `${securityHits.length} security report${securityHits.length > 1 ? 's' : ''} on this route`,
      detail: `Travel in daylight, keep moving, and avoid stopping around ${
        securityHits[0].place ?? securityHits[0].road ?? 'the flagged stretch'
      }.`,
    });
  }

  const arrival = departAt ? new Date(departAt.getTime() + durationS * 1000) : null;
  if (arrival && (arrival.getHours() >= 19 || arrival.getHours() < 5)) {
    out.push({
      level: securityHits.length ? 'high' : 'medium',
      title: 'You would arrive after dark',
      detail: `Estimated arrival ${arrival.toLocaleTimeString('en-NG', {
        hour: '2-digit',
        minute: '2-digit',
      })}. Night driving on inter-state roads is the single biggest risk factor — consider leaving earlier or breaking the journey.`,
    });
  }

  if (count('flooding')) {
    out.push({
      level: 'high',
      title: `Flooding reported on the way`,
      detail: 'Do not drive into standing water you cannot see the bottom of. Check for a diversion before you set off.',
    });
  } else if (month >= 6 && month <= 10 && totalKm > 120) {
    out.push({
      level: 'low',
      title: 'Rainy season route',
      detail: 'June–October: expect surface water and slower going, especially on unlit stretches.',
    });
  }

  const checkpoints = count('checkpoint');
  if (checkpoints >= 2) {
    out.push({
      level: 'low',
      title: `${checkpoints} checkpoints reported`,
      detail: 'Keep your licence, vehicle papers and ID somewhere you can reach without getting out.',
    });
  }

  if (durationS > 5 * 3600) {
    out.push({
      level: 'low',
      title: 'Long haul',
      detail: `About ${Math.round(durationS / 3600)} hours of driving. Plan a stop roughly every two and a half hours.`,
    });
  }

  if (!active.length && totalKm > 30) {
    out.push({
      level: 'info',
      title: 'Nothing reported on this route',
      detail: 'Either it is genuinely clear or nobody has reported recently. Add a report as you travel so the next driver knows.',
    });
  }

  if (score < 45) {
    out.unshift({
      level: 'high',
      title: 'Consider an alternative route or day',
      detail: 'This corridor is carrying multiple confirmed problems right now.',
    });
  }

  return out;
}

/** One-line summary used by the assistant and trip notifications. */
export function summarise(analysis) {
  if (!analysis.hazardCount) return 'No active reports on this route.';
  const bits = Object.entries(analysis.byCategory)
    .map(([cat, n]) => `${n} ${cat}`)
    .join(', ');
  return `${analysis.hazardCount} active report${analysis.hazardCount > 1 ? 's' : ''} on route (${bits}). Safety score ${analysis.score}/100 — ${analysis.gradeLabel.toLowerCase()}.`;
}
