/**
 * The in-app assistant.
 *
 * Design rule: it must be genuinely useful with **no API key at all**. The
 * deterministic engine below answers from the live database — distances,
 * hazards, fuel prices, trip status — because a driver on the Benin bypass
 * needs a straight answer, not a language model.
 *
 * If an LLM key is configured it is used only to phrase the answer more
 * naturally, and it is handed the same facts the deterministic engine found.
 */

import { config } from '../config.js';
import { log } from '../logger.js';
import { haversine, format } from './geo.js';
import { search as searchPlaces, describe, nearest } from './gazetteer.js';
import { listReports, hotspots, reportCounts } from './reports.js';
import { clusterStations, marketPrice } from './fuel.js';
import { getTrip } from './trips.js';
import { REPORT_TYPES } from './taxonomy.js';
import { planRoute } from './planner.js';

const naira = (n) => `₦${Math.round(n).toLocaleString('en-NG')}`;

function matchAny(text, patterns) {
  return patterns.some((p) => p.test(text));
}

/**
 * Words that people put in front of a place name but that are never part of
 * one: "how safe is Lagos to Benin" must not ask for a town called
 * "how safe is Lagos".
 */
const LEAD_IN = new RegExp(
  String.raw`^(?:\s*(?:hi|hey|hello|please|pls|abeg|ok|okay)\b[\s,]*)*` +
    String.raw`(?:\s*(?:what(?:'s| is)?|how|is|are|does|do|can|could|should|would|will|tell me|show me|give me|i want|i need|i am|i'm|we are|we're|let'?s|any|there)\b\s*)*` +
    String.raw`(?:\s*(?:far|long|safe|safety|safer|dangerous|risky|bad|good|much|many|it|the|a|an|my|our|this|that|route|road|roads|drive|driving|driver|trip|journey|way|going|go|get|getting|travel|travelling|traveling|ride|distance|time|hours|hrs|km|kilometres|kilometers|condition|conditions|situation|like|about|between|of|on|in|to be|now|today|tonight|tomorrow|morning|evening)\b\s*)*`,
  'i',
);

/** Trailing words that are commentary, not part of the destination. */
const TRAIL = new RegExp(
  String.raw`\s*\b(?:now|today|tonight|tomorrow|this (?:morning|afternoon|evening|night|week)|right now|at night|by road|please|abeg|thanks?)\b\s*$`,
  'i',
);

function tidyEndpoint(value) {
  let out = String(value ?? '').trim();
  let previous;
  do {
    previous = out;
    out = out.replace(LEAD_IN, '').replace(TRAIL, '').trim();
  } while (out !== previous);
  return out.replace(/^[\s,.:;-]+|[\s,.:;?!-]+$/g, '').trim();
}

/**
 * Common words that are never a place, even though a fuzzy search will happily
 * match them ("go" → Gombe, "to go" → Toro).
 */
const STOPWORDS = new Set(
  `a an and any are as at be been but by can could do does far for from get getting go going good
   had has have here how i if in is it its like long many much me my need no not now of on or our out
   please pls right road roads route safe safety should show so some take tell that the then there they
   this to today tomorrow tonight travel trip up us want was way we what when where which who why will
   with would you your abeg drive driving journey time hours hrs km`.split(/\s+/),
);

/** A match below this is fuzzy noise rather than a real place. */
const MIN_PLACE_SCORE = 45;

/**
 * Find the place hiding inside a phrase.
 *
 * "is it safe to drive Abuja" → Abuja. "Aba take" → Aba. "I need to go" →
 * nothing, because every word in it is a stopword.
 */
function resolvePhrase(phrase) {
  const words = tidyEndpoint(phrase).split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  let best = null;
  for (let start = 0; start < words.length; start += 1) {
    for (let end = Math.min(words.length, start + 4); end > start; end -= 1) {
      const window = words.slice(start, end);
      if (window.every((w) => STOPWORDS.has(w.toLowerCase()))) continue;
      const text = window.join(' ');
      const [hit] = searchPlaces(text, { limit: 1 });
      if (!hit || hit.score < MIN_PLACE_SCORE) continue;
      // Prefer strong matches, longer phrases, and words nearer the end of the
      // fragment ("drive Abuja" — the town is the last thing said).
      const score = hit.score + window.length * 8 + start * 3;
      if (!best || score > best.score) best = { hit, text, score };
    }
  }
  return best;
}

/**
 * Pull a journey out of a sentence.
 *
 * People write "Kano to Kaduna", "how far from Ikeja to Ibadan", "is it safe
 * to drive Abuja to Jos today". The separator is ambiguous — "safe **to**
 * drive" is not a journey — so every candidate split is tried and the one
 * whose two halves both resolve to real places wins.
 */
function extractLeg(text) {
  const cleaned = text.replace(/[?!]+\s*$/, '').trim();
  const separators = [...cleaned.matchAll(/\s+(?:to|→|->|-->)\s+/gi)];
  if (!separators.length) return null;

  const candidates = [];
  for (const separator of separators) {
    const rawFrom = cleaned.slice(0, separator.index);
    const rawTo = cleaned.slice(separator.index + separator[0].length).split(/\b(?:and|then|but|because|so)\b/i)[0];

    // "from X to Y" is unambiguous — prefer whatever follows the word "from".
    const fromKeyword = rawFrom.match(/\bfrom\s+([^,]+)$/i);
    const from = resolvePhrase(fromKeyword ? fromKeyword[1] : rawFrom);
    const to = resolvePhrase(rawTo);
    if (!from || !to || from.hit.id === to.hit.id) continue;

    candidates.push({
      from: from.text,
      to: to.text,
      score: from.score + to.score + (fromKeyword ? 60 : 0),
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return { from: candidates[0].from, to: candidates[0].to };
}

/** "how far is it to Ibadan" — a destination with no stated origin. */
function extractDestination(text) {
  const m = text.replace(/[?!]+\s*$/, '').match(/\b(?:to|towards|for)\s+([a-z0-9'\-\s.]{3,40})$/i);
  if (!m) return null;
  return resolvePhrase(m[1])?.text ?? null;
}

function hazardLine(h) {
  const when = h.ageMinutes < 60 ? `${h.ageMinutes} min ago` : `${Math.round(h.ageMinutes / 60)}h ago`;
  const where = h.road ? `${h.road}` : h.place ?? 'unknown location';
  const at = h.alongM != null ? ` at ${Math.round(h.alongM / 1000)} km` : '';
  return `• ${h.typeLabel}${at} — ${where} (${when}${h.confirms ? `, ${h.confirms} confirmations` : ''})`;
}

/**
 * @param {{message:string, context?:object}} input
 * @returns {Promise<{intent:string, reply:string, data?:object}>}
 */
export async function reason({ message, context = {} }) {
  const text = String(message ?? '').trim();
  const lower = text.toLowerCase();
  const route = context.route ?? null;
  const position = context.position ?? null;

  if (!text) return { intent: 'empty', reply: 'Ask me about your route, road conditions, fuel or a trip code.' };

  /* ---- trip code lookup -------------------------------------------- */
  const codeMatch = text.match(/\b([A-HJ-NP-Z2-9]{6})\b/);
  if (codeMatch && matchAny(lower, [/trip|track|code|where is|arriv/])) {
    const trip = getTrip(codeMatch[1], { geometry: false });
    if (trip) {
      const bits = [
        `${trip.traveller} is travelling ${trip.from.label} → ${trip.to.label}.`,
        `Status: ${trip.status}${trip.overdue ? ` (overdue by ${trip.overdueMinutes} min)` : ''}.`,
        `Progress ${Math.round(trip.progress * 100)}%, about ${format.km(trip.remainingM)} to go.`,
        trip.eta ? `Expected ${new Date(trip.eta).toLocaleString('en-NG')}.` : '',
        trip.sos ? '⚠ An emergency signal has been raised on this trip.' : '',
      ].filter(Boolean);
      return { intent: 'trip', reply: bits.join(' '), data: { trip } };
    }
    return { intent: 'trip', reply: `No trip found with code ${codeMatch[1]}. Codes are six characters and case-insensitive.` };
  }

  /* ---- greetings ----------------------------------------------------- */
  if (/^\s*(hi|hey|hello|good (morning|afternoon|evening)|how far|wetin dey|how you dey|yo)\b[\s!.?]*$/i.test(text)) {
    const counts = reportCounts();
    return {
      intent: 'greeting',
      reply: [
        'Hello. I read this map directly.',
        `${counts.active} active reports right now, ${counts.last24h} added today.`,
        'Ask me about a route, road conditions, fuel prices, or give me a trip code.',
      ].join(' '),
    };
  }

  /* ---- route questions --------------------------------------------- */
  const leg = extractLeg(text);
  const asksDistance = matchAny(lower, [/how far|distance|how long|how many (km|hours)|time to|drive to/]);
  const asksSafety = matchAny(lower, [/safe|danger|risk|hazard|bad road|pothole|flood|robber|kidnap|security|checkpoint|condition/]);

  // A bare "Kano to Kaduna" is a route question even with no other wording:
  // extractLeg already checked that both halves are real places.
  if (leg) {
    try {
      const plan = await planRoute({ from: { q: leg.from }, to: { q: leg.to }, alternatives: false });
      const best = plan.routes[0];
      const lines = [
        `${plan.from.label} → ${plan.to.label}: ${format.km(best.distanceM)}, about ${format.duration(best.durationS)} driving${
          plan.engine === 'offline' ? ' (offline estimate)' : ''
        }.`,
        best.roads.length ? `Main roads: ${best.roads.slice(0, 4).join(', ')}.` : '',
        `Safety score ${best.safety.score}/100 — ${best.safety.gradeLabel.toLowerCase()}.`,
      ];
      if (best.hazards.length) {
        lines.push(`Reported on the way:\n${best.hazards.slice(0, 6).map(hazardLine).join('\n')}`);
      } else {
        lines.push('No active community reports on that corridor right now.');
      }
      if (best.fuel.needsRefuel) {
        const stop = best.fuel.stops.find((s) => s.kind === 'stop');
        lines.push(
          stop
            ? `Fuel: you will need roughly ${best.fuel.litresNeeded} L (${naira(best.fuel.estimatedCost)}). Suggested stop around ${stop.atKm} km at ${stop.station.name}.`
            : `Fuel: roughly ${best.fuel.litresNeeded} L needed (${naira(best.fuel.estimatedCost)}), and no confirmed station on that stretch — start with a full tank.`,
        );
      }
      return { intent: 'route', reply: lines.filter(Boolean).join('\n'), data: { plan: { from: plan.from, to: plan.to, route: best } } };
    } catch (error) {
      return { intent: 'route', reply: error.message ?? 'I could not work out that route.' };
    }
  }

  /* ---- a destination with no origin --------------------------------- */
  const wantsToTravel = matchAny(lower, [
    /\b(go|going|drive|driving|travel|travelling|traveling|head|heading|route|road|way|journey|trip|leave|leaving|reach)\b/,
  ]);
  if (!leg && (asksDistance || asksSafety || wantsToTravel)) {
    const destination = extractDestination(text);
    if (destination) {
      if (position) {
        try {
          const plan = await planRoute({
            from: { lat: position.lat, lon: position.lon, label: 'your position' },
            to: { q: destination },
            alternatives: false,
          });
          const best = plan.routes[0];
          return {
            intent: 'route',
            reply: [
              `From where you are now to ${plan.to.label}: ${format.km(best.distanceM)}, about ${format.duration(best.durationS)}.`,
              `Safety score ${best.safety.score}/100 — ${best.safety.gradeLabel.toLowerCase()}.`,
              best.hazards.length
                ? `Reported on the way:\n${best.hazards.slice(0, 5).map(hazardLine).join('\n')}`
                : 'Nothing reported on that corridor right now.',
            ].join('\n'),
            data: { plan: { from: plan.from, to: plan.to, route: best } },
          };
        } catch (error) {
          return { intent: 'route', reply: error.message ?? 'I could not work out that route.' };
        }
      }
      return {
        intent: 'route',
        reply: `Starting from where? Ask me "from <town> to ${destination}", or turn on location and I will measure it from where you are.`,
      };
    }
  }

  /* ---- questions about the route already on screen ------------------ */
  if (route && (asksDistance || asksSafety || matchAny(lower, [/my route|this route|the route|on the way|ahead/]))) {
    const hazards = route.hazards ?? [];
    const lines = [
      `Your planned route ${route.from} → ${route.to} is ${format.km(route.distanceM)} and about ${format.duration(route.durationS)} of driving.`,
      `Safety score ${route.safety?.score ?? '—'}/100.`,
    ];
    if (hazards.length) lines.push(`On the way:\n${hazards.slice(0, 8).map(hazardLine).join('\n')}`);
    else lines.push('Nothing has been reported on it recently.');
    return { intent: 'current-route', reply: lines.join('\n'), data: { route } };
  }

  /* ---- fuel ---------------------------------------------------------- */
  if (matchAny(lower, [/fuel|petrol|diesel|pms|filling station|pump price|litre|liter/])) {
    const centre = position ?? (route ? { lat: route.fromLat, lon: route.fromLon } : null);
    const reports = centre
      ? listReports({ near: [centre.lat, centre.lon], radiusM: 60000, categories: ['fuel'], limit: 200 })
      : listReports({ categories: ['fuel'], limit: 200 });
    const stations = clusterStations(reports);
    const selling = stations.filter((s) => s.hasFuel);
    const market = marketPrice(stations);
    if (!stations.length) {
      return {
        intent: 'fuel',
        reply: 'No fuel reports around here yet. If you pass a station, drop a report — price and queue length help everyone.',
      };
    }
    const top = selling.slice(0, 5).map((s) => {
      const dist = centre ? ` — ${format.km(haversine([centre.lat, centre.lon], [s.lat, s.lon]))} away` : '';
      return `• ${s.name}${s.brand ? ` (${s.brand})` : ''}${s.price ? ` at ${naira(s.price)}/L` : ''}${dist}${s.queue ? `, queue: ${s.queue}` : ''}`;
    });
    return {
      intent: 'fuel',
      reply: [
        `${selling.length} station${selling.length === 1 ? '' : 's'} reported selling, ${stations.length - selling.length} dry.`,
        market.samples ? `Community price right now: ${naira(market.price)}/L from ${market.samples} report${market.samples === 1 ? '' : 's'}.` : '',
        top.length ? top.join('\n') : '',
      ]
        .filter(Boolean)
        .join('\n'),
      data: { stations: selling.slice(0, 10), market },
    };
  }

  /* ---- around me ------------------------------------------------------ */
  if (matchAny(lower, [/near me|around me|nearby|close to me|my area|here/]) && position) {
    const reports = listReports({ near: [position.lat, position.lon], radiusM: 30000, limit: 60 });
    if (!reports.length) {
      return { intent: 'nearby', reply: `Nothing reported within 30 km of ${describe(position.lat, position.lon)}.` };
    }
    return {
      intent: 'nearby',
      reply: [
        `${reports.length} active report${reports.length === 1 ? '' : 's'} within 30 km of ${describe(position.lat, position.lon)}:`,
        ...reports.slice(0, 8).map((r) => `• ${r.typeLabel} — ${r.road ?? r.place} (${format.km(r.distanceM)} away)`),
      ].join('\n'),
      data: { reports: reports.slice(0, 12) },
    };
  }

  /* ---- hotspots / statistics ------------------------------------------ */
  if (matchAny(lower, [/hotspot|worst road|most report|statistic|how many report|trend|dangerous/])) {
    const spots = hotspots({ limit: 6 });
    const counts = reportCounts();
    if (!spots.length) {
      return { intent: 'insights', reply: `${counts.active} active reports in the database, ${counts.last24h} added in the last 24 hours.` };
    }
    return {
      intent: 'insights',
      reply: [
        `${counts.active} active reports, ${counts.last24h} in the last 24 hours. Current hotspots:`,
        ...spots.map(
          (s, i) => `${i + 1}. ${s.road ?? s.place} (${s.state ?? 'Nigeria'}) — ${s.count} reports, mostly ${REPORT_TYPES[s.dominantType]?.label ?? s.dominantType}`,
        ),
      ].join('\n'),
      data: { hotspots: spots, counts },
    };
  }

  /* ---- place lookup ---------------------------------------------------- */
  if (matchAny(lower, [/where is|locate|find (the )?(town|city|place)/])) {
    const q = text.replace(/.*where is\s*/i, '').replace(/[?.!]/g, '').trim();
    const hits = searchPlaces(q, { limit: 3 });
    if (hits.length) {
      const hit = hits[0];
      const ref = position ? ` It is ${format.km(haversine([position.lat, position.lon], [hit.lat, hit.lon]))} from you.` : '';
      return {
        intent: 'place',
        reply: `${hit.name} is in ${hit.state}${hit.state === 'FCT' ? '' : ' State'} at ${hit.lat.toFixed(4)}, ${hit.lon.toFixed(4)}.${ref}`,
        data: { place: hit, alternatives: hits.slice(1) },
      };
    }
  }

  /* ---- night travel / general advice ----------------------------------- */
  if (matchAny(lower, [/night|dark|evening|safe time|when should i (leave|travel)/])) {
    return {
      intent: 'advice',
      reply: [
        'Rule of thumb for inter-state travel in Nigeria: be off the highway before dark.',
        '• Leave early — most drivers aim to be moving by 6–7am.',
        '• Work back from sunset (~6:30–7pm) rather than from your ETA.',
        '• Share a trip code before you set off so someone knows your route and expected arrival.',
        '• If you must arrive late, pick the busier corridor even if it is longer.',
      ].join('\n'),
    };
  }

  if (matchAny(lower, [/help|what can you do|how do (i|you)/])) {
    return {
      intent: 'help',
      reply: [
        'I read this map\'s live data. Try:',
        '• "How far from Ikeja to Benin City?"',
        '• "Is the Lokoja to Abuja road safe today?"',
        '• "Where can I buy fuel near me?"',
        '• "What are the current hotspots?"',
        '• "Track trip ABC234"',
      ].join('\n'),
    };
  }

  /* ---- fallback: give them something real ------------------------------- */
  const counts = reportCounts();
  const near = position ? listReports({ near: [position.lat, position.lon], radiusM: 40000, limit: 5 }) : [];
  return {
    intent: 'fallback',
    reply: [
      'I answer from this map\'s live data — routes, road reports, fuel and trip codes.',
      `Right now there are ${counts.active} active reports (${counts.last24h} in the last day).`,
      near.length ? `Nearest to you: ${near.map((r) => r.typeLabel).join(', ')}.` : '',
      'Ask me something like "how far from Enugu to Port Harcourt" or "any flooding near me".',
    ]
      .filter(Boolean)
      .join(' '),
    data: { counts },
  };
}

/* ------------------------------------------------------------------ *
 * Optional LLM phrasing layer
 * ------------------------------------------------------------------ */
async function callAnthropic(messages, system) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.assistant.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.assistant.model || 'claude-3-5-haiku-latest',
      max_tokens: 700,
      system,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const json = await res.json();
  return (json.content ?? []).map((b) => b.text ?? '').join('\n').trim();
}

async function callOpenAI(messages, system) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.assistant.openaiKey}` },
    body: JSON.stringify({
      model: config.assistant.model || 'gpt-4o-mini',
      max_tokens: 700,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() ?? '';
}

export function assistantMode() {
  if (config.assistant.provider === 'anthropic' && config.assistant.anthropicKey) return 'anthropic';
  if (config.assistant.provider === 'openai' && config.assistant.openaiKey) return 'openai';
  return 'builtin';
}

/**
 * Public entry point used by the API route.
 */
export async function ask({ message, context = {}, history = [] }) {
  const grounded = await reason({ message, context });
  const mode = assistantMode();
  if (mode === 'builtin') return { ...grounded, mode };

  const system = [
    'You are the assistant inside Naija Routes, a Nigerian road-travel map.',
    'Answer in at most 120 words, plain and practical, no markdown headers.',
    'You MUST base every factual claim on the FACTS block below. If a fact is missing, say so plainly.',
    'Never invent distances, prices, road names or report counts.',
    '',
    'FACTS (generated from the live database just now):',
    grounded.reply,
    grounded.data ? `\nStructured data: ${JSON.stringify(grounded.data).slice(0, 4000)}` : '',
  ].join('\n');

  const messages = [...history.slice(-6), { role: 'user', content: message }];

  try {
    const text = mode === 'anthropic' ? await callAnthropic(messages, system) : await callOpenAI(messages, system);
    if (text) return { ...grounded, reply: text, mode };
  } catch (error) {
    log.warn('assistant LLM call failed, using built-in answer', { error: error.message });
  }
  return { ...grounded, mode: 'builtin-fallback' };
}
