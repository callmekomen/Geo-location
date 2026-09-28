/**
 * The vocabulary of the whole product: what can be reported, how long it stays
 * true, and how much it should scare a driver.
 *
 * `ttlHours` is deliberately type-specific. A flooded underpass is stale news
 * in three days; a pothole the size of a bathtub will still be there next
 * month; a fuel queue is worthless information by tomorrow morning.
 */

export const CATEGORIES = {
  road: { label: 'Road condition', colour: '#C97B33' },
  traffic: { label: 'Traffic', colour: '#C1442D' },
  security: { label: 'Security', colour: '#8B2F4F' },
  fuel: { label: 'Fuel', colour: '#2F6D4F' },
  place: { label: 'Place update', colour: '#5B4B8A' },
  clear: { label: 'All clear', colour: '#2F6D4F' },
};

/**
 * severity: 0 = informational, 1 = minor, 2 = significant, 3 = serious.
 * weight:   how strongly the type drags down a route's safety score.
 */
export const REPORT_TYPES = {
  pothole: {
    label: 'Bad road / pothole',
    category: 'road',
    severity: 2,
    weight: 1.0,
    ttlHours: 24 * 45,
    colour: '#C97B33',
    icon: 'pothole',
    hint: 'Broken surface, craters, failed patches.',
  },
  flooding: {
    label: 'Flooding',
    category: 'road',
    severity: 3,
    weight: 1.6,
    ttlHours: 72,
    colour: '#2B7A8C',
    icon: 'flood',
    hint: 'Water over the road — say how deep if you can.',
  },
  accident: {
    label: 'Accident',
    category: 'traffic',
    severity: 3,
    weight: 1.5,
    ttlHours: 8,
    colour: '#C1442D',
    icon: 'accident',
    hint: 'Crash blocking or slowing the road.',
  },
  gridlock: {
    label: 'Heavy traffic',
    category: 'traffic',
    severity: 2,
    weight: 0.9,
    ttlHours: 4,
    colour: '#D9682F',
    icon: 'traffic',
    hint: 'Standstill or crawling traffic.',
  },
  construction: {
    label: 'Roadworks',
    category: 'road',
    severity: 2,
    weight: 0.8,
    ttlHours: 24 * 60,
    colour: '#B08900',
    icon: 'works',
    hint: 'Construction, diversion or single-lane working.',
  },
  obstruction: {
    label: 'Obstruction',
    category: 'road',
    severity: 2,
    weight: 1.0,
    ttlHours: 18,
    colour: '#8A5A2E',
    icon: 'obstruction',
    hint: 'Broken-down truck, fallen tree, spilled load.',
  },
  checkpoint: {
    label: 'Checkpoint',
    category: 'security',
    severity: 1,
    weight: 0.5,
    ttlHours: 14,
    colour: '#4A6FA5',
    icon: 'checkpoint',
    hint: 'Police, army or customs stop.',
  },
  security: {
    label: 'Security risk',
    category: 'security',
    severity: 3,
    weight: 2.2,
    ttlHours: 24 * 10,
    colour: '#8B2F4F',
    icon: 'security',
    hint: 'Robbery, kidnapping or armed activity reported here.',
  },
  protest: {
    label: 'Protest / road block',
    category: 'security',
    severity: 3,
    weight: 1.4,
    ttlHours: 16,
    colour: '#9B3B6E',
    icon: 'protest',
    hint: 'Demonstration, union action or a barricaded road.',
  },
  fuel_available: {
    label: 'Fuel available',
    category: 'fuel',
    severity: 0,
    weight: 0,
    ttlHours: 14,
    colour: '#2F6D4F',
    icon: 'fuel-yes',
    hint: 'Station selling now — add the price if you know it.',
    fields: ['price', 'queue', 'brand', 'product'],
  },
  fuel_out: {
    label: 'No fuel',
    category: 'fuel',
    severity: 1,
    weight: 0.2,
    ttlHours: 14,
    colour: '#C1442D',
    icon: 'fuel-no',
    hint: 'Station is dry or not selling.',
    fields: ['brand', 'product'],
  },
  closed: {
    label: 'Permanently closed',
    category: 'place',
    severity: 0,
    weight: 0,
    ttlHours: 24 * 365,
    colour: '#5B4B8A',
    icon: 'closed',
    hint: 'Business or facility that no longer exists here.',
  },
  relocated: {
    label: 'Relocated',
    category: 'place',
    severity: 0,
    weight: 0,
    ttlHours: 24 * 365,
    colour: '#5B4B8A',
    icon: 'relocated',
    hint: 'Moved somewhere else — say where in the note.',
  },
  renamed: {
    label: 'Renamed',
    category: 'place',
    severity: 0,
    weight: 0,
    ttlHours: 24 * 365,
    colour: '#5B4B8A',
    icon: 'renamed',
    hint: 'Known by a different name now.',
  },
  clear: {
    label: 'Road is clear',
    category: 'clear',
    severity: 0,
    weight: -0.6,
    ttlHours: 10,
    colour: '#2F6D4F',
    icon: 'clear',
    hint: 'Confirms a stretch is moving well right now.',
  },
};

export const REPORT_TYPE_IDS = Object.keys(REPORT_TYPES);

export function typeMeta(type) {
  return REPORT_TYPES[type] ?? null;
}

export function isValidType(type) {
  return Object.hasOwn(REPORT_TYPES, type);
}

/** Types whose truth is short-lived enough to show a "still there?" prompt. */
export const VOLATILE_TYPES = REPORT_TYPE_IDS.filter((t) => REPORT_TYPES[t].ttlHours <= 24);

export const VEHICLES = {
  car: { label: 'Car', consumptionKmPerLitre: 11, tankLitres: 50, speedFactor: 1 },
  suv: { label: 'SUV / pickup', consumptionKmPerLitre: 8.5, tankLitres: 70, speedFactor: 1 },
  bus: { label: 'Bus / danfo', consumptionKmPerLitre: 7, tankLitres: 70, speedFactor: 0.92 },
  truck: { label: 'Truck', consumptionKmPerLitre: 4, tankLitres: 200, speedFactor: 0.78 },
  bike: { label: 'Motorcycle', consumptionKmPerLitre: 35, tankLitres: 12, speedFactor: 0.95 },
};

/** Default pump price (₦/litre) used when nobody has reported one nearby. */
export const DEFAULT_FUEL_PRICE = 1050;
