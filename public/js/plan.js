/** The Plan tab: search endpoints, request a route, render the intelligence. */

import { $, el, fmt, glyph, debounce, toLocalInputValue, scoreColour, toast, escapeHtml } from './util.js';
import { api } from './api.js';
import { state, setState, activeRoute } from './store.js';
import { mapview } from './mapview.js';

let onPlanned = () => {};
let requestPosition = async () => null;

/* ---------------------------------------------------------- autocomplete */
function wireAutocomplete(inputId, suggestId, stateKey) {
  const input = $(`#${inputId}`);
  const panel = $(`#${suggestId}`);
  let items = [];
  let cursor = -1;

  const close = () => {
    panel.hidden = true;
    cursor = -1;
  };

  const choose = (place) => {
    input.value = place.label ?? place.name;
    setState({ [stateKey]: { lat: place.lat, lon: place.lon, label: place.label ?? place.name } });
    close();
    mapview.flyTo(place.lat, place.lon, 11);
  };

  const render = () => {
    panel.replaceChildren(
      ...items.map((place, index) =>
        el(
          'button',
          { type: 'button', class: index === cursor ? 'active' : '', onclick: () => choose(place) },
          [
            el('span', { text: glyph(place.kind === 'airport' ? 'pin' : 'pin'), style: { opacity: 0.5, fontSize: '11px' } }),
            el('span', { class: 'name', text: place.name }),
            el('span', { class: 'sub', text: place.state ?? place.source ?? '' }),
          ],
        ),
      ),
    );
    panel.hidden = items.length === 0;
  };

  const search = debounce(async (value) => {
    if (value.trim().length < 2) return close();
    try {
      const near = state.position ? [state.position.lat, state.position.lon] : null;
      const { results } = await api.places(value.trim(), near);
      items = results.slice(0, 7);
      cursor = -1;
      render();
    } catch {
      close();
    }
  }, 180);

  input.addEventListener('input', () => {
    setState({ [stateKey]: null });
    search(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (panel.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(cursor + 1, items.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      render();
    } else if (event.key === 'Enter' && cursor >= 0) {
      event.preventDefault();
      choose(items[cursor]);
    } else if (event.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 160));
  return input;
}

/* --------------------------------------------------------------- render */
function safetyRing(route) {
  return el('div', { class: 'score-ring', style: { '--val': route.safety.score, '--col': scoreColour(route.safety.score) } }, [
    el('div', {}, [el('span', { text: route.safety.score }), el('small', { text: 'SAFETY' })]),
  ]);
}

function routeCard(route, plan, isActive) {
  const card = el('div', { class: `card selectable route-card ${isActive ? 'selected' : ''}` }, [
    el('div', { class: 'route-top' }, [
      safetyRing(route),
      el('div', { class: 'route-figures' }, [
        el('div', { class: `route-label ${route.recommendedFor === 'safety' ? 'safer' : ''}`, text: route.label }),
        el('div', { class: 'big', html: `${fmt.km(route.distanceM)}<span>·</span>${fmt.duration(route.durationS)}` }),
        el('div', { class: 'sub', text: `Arrive ${fmt.dayTime(route.arrivalAt)} · ${route.roads.slice(0, 2).join(', ') || 'local roads'}` }),
      ]),
    ]),
    el('div', { class: 'stat-grid' }, [
      el('div', { class: 'stat' }, [
        el('div', { class: 'v', text: route.safety.hazardCount }),
        el('div', { class: 'k', text: 'hazards' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'v', text: `${route.fuel.litresNeeded}L` }),
        el('div', { class: 'k', text: 'fuel needed' }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'v', text: fmt.naira(route.fuel.estimatedCost) }),
        el('div', { class: 'k', text: 'est. cost' }),
      ]),
    ]),
  ]);
  card.addEventListener('click', () => {
    setState({ activeRouteId: route.id });
    renderResults();
    mapview.renderPlan(plan, route.id);
  });
  return card;
}

function hazardTimeline(route) {
  if (!route.hazards.length) return null;
  const track = el('div', { class: 'timeline-track' });
  for (const hazard of route.hazards) {
    const pip = el('div', {
      class: 'timeline-pip',
      style: { left: `${hazard.alongPct}%`, background: hazard.colour },
      title: `${hazard.typeLabel} at ${Math.round(hazard.alongM / 1000)} km`,
      onclick: () => mapview.highlightHazard(hazard),
    });
    track.append(pip);
  }
  return el('div', { class: 'timeline' }, [
    track,
    el('div', { class: 'timeline-ends' }, [
      el('span', { text: 'Start' }),
      el('span', { text: fmt.km(route.distanceM) }),
    ]),
  ]);
}

function hazardItem(hazard, route) {
  const etaMin = Math.round(hazard.etaFromStartS / 60);
  return el(
    'div',
    { class: 'hazard-item', onclick: () => mapview.highlightHazard(hazard) },
    [
      el('div', { class: 'hz-mark', style: { background: `${hazard.colour}22`, color: hazard.colour }, text: glyph(hazard.icon) }),
      el('div', { class: 'hz-body' }, [
        el('div', { class: 'hz-title' }, [
          el('span', { text: hazard.label || hazard.typeLabel }),
          el('span', { class: 'confidence', style: { '--w': `${Math.round(hazard.confidence * 100)}%` } }, [el('i', {})]),
        ]),
        el('div', {
          class: 'hz-meta',
          text: `${hazard.typeLabel} · ${hazard.road ?? hazard.place ?? ''} · ${fmt.ago(hazard.createdAt)}${
            hazard.confirms ? ` · ${hazard.confirms} confirmed` : ''
          }`,
        }),
        hazard.note ? el('div', { class: 'hz-note', text: hazard.note }) : null,
      ]),
      el('div', { class: 'hz-dist' }, [
        el('div', { text: `${Math.round(hazard.alongM / 1000)} km` }),
        el('div', { style: { color: 'var(--text-faint)', marginTop: '2px' }, text: `~${fmt.minutes(etaMin)}` }),
        hazard.offRouteM > 400 ? el('div', { style: { color: 'var(--text-faint)', fontSize: '10px' }, text: `${fmt.km(hazard.offRouteM)} off` }) : null,
      ]),
    ],
  );
}

function fuelBlock(route) {
  const fuel = route.fuel;
  const rows = [];
  rows.push(
    el('div', { class: 'kv' }, [
      el('span', { text: 'Range on current tank' }),
      el('b', { text: `${fuel.rangeKm} km` }),
    ]),
    el('div', { class: 'kv' }, [
      el('span', { text: `Pump price (${fuel.price.source})` }),
      el('b', { text: `${fmt.naira(fuel.price.price)}/L` }),
    ]),
    el('div', { class: 'kv' }, [
      el('span', { text: 'Stations reported on route' }),
      el('b', { text: `${fuel.sellingOnRoute} selling / ${fuel.stationsOnRoute} known` }),
    ]),
  );

  const stops = fuel.stops.map((stop) =>
    stop.kind === 'stop'
      ? el('div', { class: 'fuel-line' }, [
          el('span', { class: 'km', text: `${stop.atKm} km` }),
          el('span', { text: stop.station.name }),
          el('span', { class: 'price', text: stop.priceKnown ? `${fmt.naira(stop.price)}/L` : 'price unknown' }),
        ])
      : el('div', { class: 'fuel-line' }, [
          el('span', { class: 'km', text: `${stop.fromKm}–${stop.toKm}` }),
          el('span', { style: { color: 'var(--alert)' }, text: stop.message }),
        ]),
  );

  return el('div', { class: 'card' }, [
    el('div', { class: 'section-head', style: { marginTop: '0', paddingTop: '0', borderTop: 'none' } }, [
      el('h2', { text: 'Fuel plan' }),
      el('span', { class: 'meta', text: fuel.needsRefuel ? 'refuel required' : 'tank is enough' }),
    ]),
    ...rows,
    ...(stops.length ? [el('div', { style: { marginTop: '8px' } }, stops)] : []),
  ]);
}

function stepsBlock(route) {
  if (!route.steps.length) return null;
  return el('details', { class: 'steps card' }, [
    el('summary', { text: `Turn-by-turn (${route.steps.length} steps)` }),
    ...route.steps.map((step, i) =>
      el('div', { class: 'step' }, [
        el('span', { class: 'n', text: `${i + 1}` }),
        el('span', { text: step.instruction }),
        step.distanceM ? el('span', { class: 'd', text: fmt.km(step.distanceM) }) : null,
      ]),
    ),
  ]);
}

export function renderResults() {
  const host = $('#planResults');
  const plan = state.plan;
  if (!plan) {
    host.replaceChildren();
    return;
  }
  const route = activeRoute();

  const children = [
    el('div', { class: 'section-head' }, [
      el('h2', { text: plan.routes.length > 1 ? 'Route options' : 'Route' }),
      el('span', { class: 'meta', text: plan.engine === 'offline' ? 'offline engine' : 'live road data' }),
    ]),
    ...plan.routes.map((r) => routeCard(r, plan, r.id === route.id)),
  ];

  if (route.advisories.length) {
    children.push(el('div', { class: 'section-head' }, [el('h2', { text: 'Before you go' })]));
    children.push(...route.advisories.map((a) => el('div', { class: `advisory ${a.level}` }, [
      el('div', {}, [el('strong', { text: a.title }), el('p', { text: a.detail })]),
    ])));
  }

  children.push(
    el('div', { class: 'section-head' }, [
      el('h2', { text: 'On this route' }),
      el('span', { class: 'meta', text: `${route.safety.hazardCount} active · corridor ${fmt.km(route.safety.corridorM)}` }),
    ]),
  );

  if (route.hazards.length) {
    children.push(hazardTimeline(route));
    if (route.safety.worstStretch) {
      const w = route.safety.worstStretch;
      children.push(
        el('div', { class: 'advisory medium' }, [
          el('div', {}, [
            el('strong', { text: `Worst stretch: km ${w.fromKm}–${w.toKm}` }),
            el('p', { text: `${w.count} reports${w.road ? ` around ${w.road}` : ''}. Slow down through here.` }),
          ]),
        ]),
      );
    }
    children.push(el('div', { class: 'card' }, route.hazards.map((h) => hazardItem(h, route))));
  } else {
    children.push(
      el('div', { class: 'empty', html: 'Nothing reported on this corridor.<br>Add what you see as you drive — someone behind you needs it.' }),
    );
  }

  children.push(fuelBlock(route));
  const steps = stepsBlock(route);
  if (steps) children.push(steps);

  children.push(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn ghost small',
        text: 'Share this trip',
        onclick: () => document.getElementById('tab-trip').click(),
      }),
      el('button', {
        class: 'btn ghost small',
        text: 'Re-scan hazards',
        onclick: () => plan && runPlan(),
      }),
    ]),
  );

  host.replaceChildren(...children);
}

/* ---------------------------------------------------------------- actions */
async function resolveInputs() {
  const fromText = $('#fromInput').value.trim();
  const toText = $('#toInput').value.trim();
  if (!fromText && !state.from) throw new Error('Where are you starting from?');
  if (!toText && !state.to) throw new Error('Where are you going?');
  return {
    from: state.from ?? { q: fromText },
    to: state.to ?? { q: toText },
  };
}

export async function runPlan() {
  const status = $('#planStatus');
  const button = $('#planBtn');
  try {
    const { from, to } = await resolveInputs();
    button.disabled = true;
    status.textContent = 'Finding the road and scanning community reports…';
    $('#planResults').replaceChildren(el('div', { class: 'skeleton', style: { height: '140px' } }));

    const plan = await api.route({
      from,
      to,
      vehicle: $('#vehicleSelect').value,
      departAt: $('#departInput').value ? new Date($('#departInput').value).toISOString() : undefined,
      tankPct: Number($('#tankRange').value) / 100,
      alternatives: true,
    });

    setState({ plan, activeRouteId: plan.routes[0].id, from: plan.from, to: plan.to });
    $('#fromInput').value = plan.from.label;
    $('#toInput').value = plan.to.label;
    status.textContent = plan.engineNote;
    renderResults();
    mapview.renderPlan(plan, plan.routes[0].id);
    onPlanned(plan);

    const worst = plan.routes[0].safety;
    if (worst.score < 50) {
      toast(`Safety score ${worst.score}/100 on this route`, { tone: 'bad', detail: `${worst.hazardCount} active reports on the corridor` });
    }
  } catch (error) {
    status.innerHTML = `<span style="color:var(--alert)">${escapeHtml(error.message)}</span>`;
    $('#planResults').replaceChildren();
  } finally {
    button.disabled = false;
  }
}

export function setEndpointFromMap(which, point, label) {
  const input = $(which === 'from' ? '#fromInput' : '#toInput');
  input.value = label;
  setState({ [which]: { lat: point.lat, lon: point.lon, label } });
}

export function initPlan({ onRoutePlanned, onRequestPosition } = {}) {
  onPlanned = onRoutePlanned ?? (() => {});
  requestPosition = onRequestPosition ?? (async () => null);

  wireAutocomplete('fromInput', 'fromSuggest', 'from');
  wireAutocomplete('toInput', 'toSuggest', 'to');

  $('#departInput').value = toLocalInputValue(new Date());

  $('#tankRange').addEventListener('input', (event) => {
    $('#tankValue').textContent = `${event.target.value}%`;
  });

  $('#swapBtn').addEventListener('click', () => {
    const fromInput = $('#fromInput');
    const toInput = $('#toInput');
    [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
    const { from, to } = state;
    setState({ from: to, to: from });
  });

  $('#planBtn').addEventListener('click', runPlan);

  $('#useMyLocationBtn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const original = button.innerHTML; // static markup from index.html, safe to restore
    button.disabled = true;
    button.textContent = 'Locating…';
    try {
      const position = await requestPosition();
      if (!position) throw new Error('Location is not available');
      let label = `${position.lat.toFixed(4)}, ${position.lon.toFixed(4)}`;
      try {
        const place = await api.reverse(position.lat, position.lon);
        label = place.label ?? label;
      } catch {
        /* the coordinates are a perfectly good label */
      }
      $('#fromInput').value = label;
      setState({ from: { lat: position.lat, lon: position.lon, label } });
      mapview.flyTo(position.lat, position.lon, 12);
      toast('Starting from where you are', { tone: 'good', detail: label });
    } catch (error) {
      toast(error.message ?? 'Could not get your location', { tone: 'bad' });
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  });

  $('#clearRouteBtn').addEventListener('click', () => {
    setState({ plan: null, activeRouteId: null, from: null, to: null });
    $('#fromInput').value = '';
    $('#toInput').value = '';
    $('#planStatus').textContent = '';
    $('#planResults').replaceChildren();
    mapview.renderPlan(null);
  });

  mapview.onRouteClick = (id) => {
    setState({ activeRouteId: id });
    renderResults();
    mapview.renderPlan(state.plan, id);
  };
}

export function populateVehicles(meta) {
  const select = $('#vehicleSelect');
  select.replaceChildren(
    ...Object.entries(meta.vehicles).map(([id, v]) =>
      el('option', { value: id, text: `${v.label} · ${v.consumptionKmPerLitre} km/L` }),
    ),
  );
  select.value = 'car';
}
