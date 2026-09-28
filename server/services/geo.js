/**
 * Geodesy helpers used across the routing, hazard and trip services.
 *
 * Everything works on `[lat, lon]` pairs in WGS84 and returns metres unless
 * stated otherwise. For the distances we care about (a few hundred km at most)
 * a spherical earth model is well within the error budget of our data.
 */

export const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in metres between two [lat, lon] points. */
export function haversine(a, b) {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[1] - a[1]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing in degrees (0–360) from `a` to `b`. */
export function bearing(a, b) {
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Human compass label for a bearing, e.g. 200 -> "south-west". */
export function compass(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Point reached by travelling `distanceM` from `origin` on `bearingDeg`. */
export function destination(origin, bearingDeg, distanceM) {
  const d = distanceM / EARTH_RADIUS_M;
  const brng = toRad(bearingDeg);
  const lat1 = toRad(origin[0]);
  const lon1 = toRad(origin[1]);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 =
    lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [toDeg(lat2), ((toDeg(lon2) + 540) % 360) - 180];
}

/**
 * Project lat/lon onto a local flat plane (metres) around `originLat`.
 * Accurate enough for point-to-segment maths over a few kilometres.
 */
function planar(point, originLat) {
  const k = Math.cos(toRad(originLat));
  return [toRad(point[1]) * k * EARTH_RADIUS_M, toRad(point[0]) * EARTH_RADIUS_M];
}

/**
 * Shortest distance from `p` to segment `a`–`b`.
 * Returns the distance in metres, the closest point, and `t` — how far along
 * the segment the closest point sits (0 = at `a`, 1 = at `b`).
 */
export function pointToSegment(p, a, b) {
  const lat0 = (a[0] + b[0]) / 2;
  const [px, py] = planar(p, lat0);
  const [ax, ay] = planar(a, lat0);
  const [bx, by] = planar(b, lat0);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { distance: haversine(p, point), point, t };
}

/**
 * Snap a point to a polyline.
 * @returns {{distance:number, point:[number,number], index:number, t:number, along:number}}
 *   `index` is the segment index, `along` is metres travelled from the start
 *   of the polyline to the snapped point.
 */
export function pointToPolyline(p, line) {
  if (!Array.isArray(line) || line.length === 0) {
    return { distance: Infinity, point: null, index: -1, t: 0, along: 0 };
  }
  if (line.length === 1) {
    return { distance: haversine(p, line[0]), point: line[0], index: 0, t: 0, along: 0 };
  }
  let best = { distance: Infinity, point: null, index: 0, t: 0, along: 0 };
  let travelled = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const segLen = haversine(line[i], line[i + 1]);
    const hit = pointToSegment(p, line[i], line[i + 1]);
    if (hit.distance < best.distance) {
      best = { distance: hit.distance, point: hit.point, index: i, t: hit.t, along: travelled + segLen * hit.t };
    }
    travelled += segLen;
  }
  return best;
}

/** Total length of a polyline in metres. */
export function polylineLength(line) {
  let total = 0;
  for (let i = 0; i < line.length - 1; i += 1) total += haversine(line[i], line[i + 1]);
  return total;
}

/** Cumulative distance at every vertex of a polyline. */
export function cumulativeDistances(line) {
  const out = [0];
  for (let i = 1; i < line.length; i += 1) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

/** The point sitting `distanceM` along a polyline (clamped to its ends). */
export function pointAlong(line, distanceM) {
  if (!line.length) return null;
  if (distanceM <= 0) return line[0];
  let travelled = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const segLen = haversine(line[i], line[i + 1]);
    if (travelled + segLen >= distanceM) {
      const t = segLen === 0 ? 0 : (distanceM - travelled) / segLen;
      return [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t];
    }
    travelled += segLen;
  }
  return line[line.length - 1];
}

/** Bounding box `{minLat, minLon, maxLat, maxLon}` of a list of points. */
export function bounds(points) {
  const box = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
  for (const [lat, lon] of points) {
    if (lat < box.minLat) box.minLat = lat;
    if (lat > box.maxLat) box.maxLat = lat;
    if (lon < box.minLon) box.minLon = lon;
    if (lon > box.maxLon) box.maxLon = lon;
  }
  return box;
}

/** Grow a bounding box by `metres` on every side. */
export function padBounds(box, metres) {
  const dLat = (metres / EARTH_RADIUS_M) * (180 / Math.PI);
  const midLat = (box.minLat + box.maxLat) / 2;
  const dLon = dLat / Math.max(0.01, Math.cos(toRad(midLat)));
  return {
    minLat: box.minLat - dLat,
    maxLat: box.maxLat + dLat,
    minLon: box.minLon - dLon,
    maxLon: box.maxLon + dLon,
  };
}

export function boundsContain(box, lat, lon) {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}

/**
 * Ramer–Douglas–Peucker simplification. Keeps route payloads small without
 * visibly changing the drawn line.
 */
export function simplify(line, toleranceM = 40) {
  if (line.length <= 2) return line.slice();
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < line.length - 1; i += 1) {
    const d = pointToSegment(line[i], line[0], line[line.length - 1]).distance;
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= toleranceM) return [line[0], line[line.length - 1]];
  const left = simplify(line.slice(0, index + 1), toleranceM);
  const right = simplify(line.slice(index), toleranceM);
  return left.slice(0, -1).concat(right);
}

/** Decode an encoded polyline (Google/OSRM format) into [lat, lon] pairs. */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    coordinates.push([lat / factor, lon / factor]);
  }
  return coordinates;
}

/** Rough "is this inside Nigeria" test used to keep search results sane. */
export function inNigeria(lat, lon) {
  return lat >= 3.9 && lat <= 14.2 && lon >= 2.5 && lon <= 15.0;
}

export const format = {
  km(metres) {
    const km = metres / 1000;
    if (km < 1) return `${Math.round(metres)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  },
  duration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.round((total % 3600) / 60);
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m || 1} min`;
  },
};
