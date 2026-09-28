/** The Insights tab — a small "state of the roads" dashboard. */

import { $, el, fmt, glyph } from './util.js';
import { api } from './api.js';
import { mapview } from './mapview.js';

function sparkline(points, { width = 340, height = 64, colour = '#ffc328' } = {}) {
  if (points.length < 2) return el('div', { class: 'hint', text: 'Not enough history yet.' });
  const max = Math.max(...points.map((p) => p.n), 1);
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => [i * step, height - (p.n / max) * (height - 8) - 4]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const svg = `
    <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Reports per day">
      <path d="${area}" fill="${colour}" opacity="0.13"/>
      <path d="${line}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="${colour}"/>`).join('')}
    </svg>`;
  return el('div', { html: svg });
}

function barList(rows, { max, colour = 'var(--danfo)' } = {}) {
  const peak = max ?? Math.max(...rows.map((r) => r.value), 1);
  return el(
    'div',
    { class: 'bars' },
    rows.map((row) =>
      el('div', { class: 'bar-row' }, [
        el('span', { class: 'name', text: row.name, title: row.name }),
        el('span', { class: 'track' }, [
          el('i', { style: { width: `${Math.max(3, (row.value / peak) * 100)}%`, background: row.colour ?? colour } }),
        ]),
        el('span', { class: 'val', text: row.display ?? row.value }),
      ]),
    ),
  );
}

export async function renderInsights() {
  const host = $('#insightsBody');
  host.replaceChildren(el('div', { class: 'skeleton', style: { height: '120px' } }));
  try {
    const data = await api.insights(14);
    const legend = data.typeLegend;

    const nodes = [
      el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat' }, [
          el('div', { class: 'v', text: data.counts.active }),
          el('div', { class: 'k', text: 'active reports' }),
        ]),
        el('div', { class: 'stat' }, [
          el('div', { class: 'v', text: data.counts.last24h }),
          el('div', { class: 'k', text: 'last 24 h' }),
        ]),
        el('div', { class: 'stat' }, [
          el('div', { class: 'v', text: data.trips.active + data.trips.overdue }),
          el('div', { class: 'k', text: 'trips live' }),
        ]),
      ]),

      el('div', { class: 'section-head' }, [
        el('h2', { text: 'Reports per day' }),
        el('span', { class: 'meta', text: `${data.windowDays} days` }),
      ]),
      sparkline(data.daily),

      el('div', { class: 'section-head' }, [el('h2', { text: 'What people are reporting' })]),
      barList(
        data.counts.byType.slice(0, 8).map((row) => ({
          name: legend[row.type]?.label ?? row.type,
          value: row.n,
          colour: legend[row.type]?.colour,
        })),
      ),

      el('div', { class: 'section-head' }, [el('h2', { text: 'Roads taking the most hits' })]),
      data.topRoads.length
        ? barList(
            data.topRoads.map((row) => ({ name: row.road, value: row.n, display: `${row.n}` })),
          )
        : el('div', { class: 'empty', text: 'No road-level reports in this window yet.' }),

      el('div', { class: 'section-head' }, [
        el('h2', { text: 'Fuel' }),
        el('span', { class: 'meta', text: `${data.fuel.selling}/${data.fuel.stations} selling` }),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'kv' }, [
          el('span', { text: 'Community pump price' }),
          el('b', { text: `${fmt.naira(data.fuel.market.price)}/L` }),
        ]),
        el('div', { class: 'kv' }, [
          el('span', { text: 'Price reports' }),
          el('b', { text: data.fuel.market.samples }),
        ]),
        ...data.fuel.byState.slice(0, 6).map((row) =>
          el('div', { class: 'kv' }, [
            el('span', { text: row.state }),
            el('b', { text: `${fmt.naira(row.average)} · ${row.samples} report${row.samples > 1 ? 's' : ''}` }),
          ]),
        ),
      ]),

      el('div', { class: 'section-head' }, [
        el('h2', { text: 'Hotspots' }),
        el('span', { class: 'meta', text: 'tap to zoom' }),
      ]),
    ];

    if (data.hotspots.length) {
      nodes.push(
        el(
          'div',
          { class: 'card' },
          data.hotspots.map((spot, index) =>
            el('div', { class: 'hazard-item', onclick: () => mapview.flyTo(spot.lat, spot.lon, 10) }, [
              el('div', { class: 'hz-mark', text: glyph(legend[spot.dominantType] ? spot.dominantType.includes('fuel') ? 'fuel-yes' : 'pin' : 'pin') }),
              el('div', { class: 'hz-body' }, [
                el('div', { class: 'hz-title', text: spot.road ?? spot.place ?? `Hotspot ${index + 1}` }),
                el('div', {
                  class: 'hz-meta',
                  text: `${spot.state ?? 'Nigeria'} · ${spot.count} reports · mostly ${legend[spot.dominantType]?.label ?? spot.dominantType}`,
                }),
              ]),
              el('div', { class: 'hz-dist', text: `${spot.score}` }),
            ]),
          ),
        ),
      );
      mapview.renderHotspots(data.hotspots);
    } else {
      nodes.push(el('div', { class: 'empty', text: 'No repeat trouble spots in this window.' }));
    }

    nodes.push(
      el('p', { class: 'hint', style: { marginTop: '16px' }, text: `Generated ${fmt.dayTime(data.generatedAt)} from ${data.counts.total} lifetime reports.` }),
    );

    host.replaceChildren(...nodes);
  } catch (error) {
    host.replaceChildren(el('div', { class: 'empty', text: error.message ?? 'Could not load insights.' }));
  }
}
