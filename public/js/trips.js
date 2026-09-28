/** Safe-arrival trips: sharing one, and watching someone else's. */

import { $, el, fmt, copyText, toast, escapeHtml } from './util.js';
import { api } from './api.js';
import { state, setState, saveSession, activeRoute } from './store.js';
import { mapview } from './mapview.js';

let watchTimer = null;
let pingTimer = null;

/* ------------------------------------------------------- my shared trip */
function statusBadge(trip) {
  if (trip.sos) return el('span', { class: 'badge bad', text: 'SOS raised' });
  if (trip.status === 'arrived') return el('span', { class: 'badge ok', text: 'Arrived' });
  if (trip.status === 'cancelled') return el('span', { class: 'badge mute', text: 'Cancelled' });
  if (trip.overdue || trip.status === 'overdue') return el('span', { class: 'badge bad', text: `Overdue ${fmt.minutes(trip.overdueMinutes)}` });
  return el('span', { class: 'badge ok', text: 'On the way' });
}

export function renderActiveTrip(trip) {
  const host = $('#tripActive');
  if (!trip) {
    host.hidden = true;
    $('#tripStart').hidden = false;
    return;
  }
  host.hidden = false;
  $('#tripStart').hidden = true;

  const shareUrl = `${location.origin}/t/${trip.code}`;
  host.replaceChildren(
    el('div', { class: 'card' }, [
      el('div', { class: 'section-head', style: { marginTop: 0, paddingTop: 0, borderTop: 'none' } }, [
        el('h2', { text: 'Your trip is live' }),
        statusBadge(trip),
      ]),
      el('div', { class: 'code-display', text: trip.code }),
      el('p', { class: 'hint', style: { textAlign: 'center', marginBottom: '10px' }, text: 'Share this code or the link below' }),
      el('div', { class: 'btn-row', style: { marginTop: 0 } }, [
        el('button', {
          class: 'btn ghost small',
          text: 'Copy link',
          onclick: async () => {
            await copyText(shareUrl);
            toast('Tracking link copied', { tone: 'good', detail: shareUrl });
          },
        }),
        navigator.share
          ? el('button', {
              class: 'btn ghost small',
              text: 'Share…',
              onclick: () =>
                navigator
                  .share({ title: 'Follow my trip on Naija Routes', text: `Track me with code ${trip.code}`, url: shareUrl })
                  .catch(() => {}),
            })
          : null,
      ]),

      el('div', { class: 'progress-track' }, [el('i', { style: { width: `${Math.round(trip.progress * 100)}%` } })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Progress' }), el('b', { text: `${Math.round(trip.progress * 100)}%` })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Remaining' }), el('b', { text: fmt.km(trip.remainingM) })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Expected arrival' }), el('b', { text: fmt.dayTime(trip.eta) })]),
      el('div', { class: 'kv' }, [
        el('span', { text: 'Last update' }),
        el('b', { text: trip.position ? fmt.ago(trip.position.at) : 'no position yet' }),
      ]),

      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn small', text: 'I have arrived', onclick: () => endTrip('arrived') }),
        el('button', { class: 'btn ghost small', text: 'Check in', onclick: checkIn }),
      ]),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: `btn small ${trip.sos ? 'ghost' : 'danger'}`,
          text: trip.sos ? 'Clear emergency' : 'Raise emergency (SOS)',
          onclick: () => toggleSos(!trip.sos),
        }),
        el('button', { class: 'btn ghost small', text: 'Stop sharing', onclick: () => endTrip('cancelled') }),
      ]),
      el('p', { class: 'hint', style: { marginTop: '10px', marginBottom: 0 } , text:
        state.watchingPosition
          ? 'Live location is on — your position updates automatically.'
          : 'Turn on live location (map button, top right) so watchers see you move.' }),
    ]),
  );
}

async function refreshMyTrip() {
  if (!state.trip?.code) return;
  try {
    const { trip, events } = await api.trip(state.trip.code);
    setState({ trip: { ...state.trip, ...trip } });
    renderActiveTrip(state.trip);
    if (trip.status === 'arrived' || trip.status === 'cancelled') stopSharing();
  } catch {
    /* transient */
  }
}

export async function startTrip() {
  const route = activeRoute();
  const plan = state.plan;
  if (!route || !plan) {
    toast('Plan a route first', { tone: 'bad' });
    return;
  }
  try {
    const payload = {
      from: { lat: plan.from.lat, lon: plan.from.lon, label: plan.from.label },
      to: { lat: plan.to.lat, lon: plan.to.lon, label: plan.to.label },
      geometry: route.geometry,
      distanceM: route.distanceM,
      durationS: route.durationS,
      eta: route.arrivalAt,
      traveller: $('#travellerInput').value.trim() || undefined,
      note: $('#tripNote').value.trim() || undefined,
    };
    const { trip, token } = await api.createTrip(payload);
    const record = { ...trip, token };
    setState({ trip: record });
    saveSession({ trip: record, traveller: payload.traveller });
    renderActiveTrip(record);
    toast(`Trip ${trip.code} is live`, { tone: 'good', detail: 'Share the code with someone who should know you arrived' });
    startPinging();
  } catch (error) {
    toast(error.message ?? 'Could not start the trip', { tone: 'bad' });
  }
}

async function endTrip(status) {
  if (!state.trip) return;
  try {
    await api.tripStatus(state.trip.code, state.trip.token, status);
    toast(status === 'arrived' ? 'Marked as arrived — nice one.' : 'Trip sharing stopped', { tone: 'good' });
  } catch (error) {
    toast(error.message ?? 'Could not update the trip', { tone: 'bad' });
  }
  stopSharing();
}

function stopSharing() {
  clearInterval(pingTimer);
  pingTimer = null;
  setState({ trip: null });
  saveSession({ trip: null });
  renderActiveTrip(null);
}

async function checkIn() {
  if (!state.trip) return;
  const message = prompt('Quick message for whoever is watching:', 'All good, still moving');
  if (message === null) return;
  try {
    await api.checkin(state.trip.code, state.trip.token, {
      message,
      lat: state.position?.lat,
      lon: state.position?.lon,
    });
    toast('Check-in sent', { tone: 'good' });
  } catch (error) {
    toast(error.message ?? 'Check-in failed', { tone: 'bad' });
  }
}

async function toggleSos(raise) {
  if (!state.trip) return;
  if (raise && !confirm('Raise an emergency signal? Everyone watching this trip will be alerted immediately.')) return;
  try {
    const { trip } = await api.sos(state.trip.code, state.trip.token, {
      clear: !raise,
      lat: state.position?.lat,
      lon: state.position?.lon,
    });
    setState({ trip: { ...state.trip, ...trip } });
    renderActiveTrip(state.trip);
    toast(raise ? 'Emergency signal sent' : 'Emergency cleared', { tone: raise ? 'bad' : 'good' });
  } catch (error) {
    toast(error.message ?? 'Could not send the signal', { tone: 'bad' });
  }
}

/** Push our position to the server every ~20 s while a trip is live. */
export function startPinging() {
  clearInterval(pingTimer);
  pingTimer = setInterval(async () => {
    if (!state.trip?.token || !state.position) return;
    try {
      await api.ping(state.trip.code, state.trip.token, {
        lat: state.position.lat,
        lon: state.position.lon,
        speedKph: state.position.speedKph ?? undefined,
      });
      refreshMyTrip();
    } catch {
      /* will retry on the next tick */
    }
  }, 20000);
}

/* ------------------------------------------------------- watching others */
export async function watchTrip(code) {
  const panel = $('#watchPanel');
  panel.replaceChildren(el('div', { class: 'skeleton', style: { height: '90px' } }));
  clearInterval(watchTimer);

  const poll = async () => {
    try {
      const data = await api.trip(code);
      setState({ watched: data });
      renderWatched(data);
      mapview.renderTrip(data.trip, data.breadcrumbs);
    } catch (error) {
      panel.replaceChildren(el('div', { class: 'empty', text: error.message ?? 'No trip with that code' }));
      clearInterval(watchTimer);
    }
  };
  await poll();
  watchTimer = setInterval(poll, 15000);
}

function renderWatched(data) {
  const { trip, safety, events } = data;
  const panel = $('#watchPanel');
  panel.replaceChildren(
    el('div', { class: 'card' }, [
      el('div', { class: 'section-head', style: { marginTop: 0, paddingTop: 0, borderTop: 'none' } }, [
        el('h2', { text: trip.traveller }),
        statusBadge(trip),
      ]),
      el('div', { class: 'hint', style: { marginBottom: '8px' }, text: `${trip.from.label} → ${trip.to.label}` }),
      el('div', { class: 'progress-track' }, [el('i', { style: { width: `${Math.round(trip.progress * 100)}%` } })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Remaining' }), el('b', { text: fmt.km(trip.remainingM) })]),
      el('div', { class: 'kv' }, [el('span', { text: 'Expected' }), el('b', { text: fmt.dayTime(trip.eta) })]),
      el('div', { class: 'kv' }, [
        el('span', { text: 'Last seen' }),
        el('b', { text: trip.position ? `${fmt.ago(trip.position.at)}` : '—' }),
      ]),
      safety
        ? el('div', { class: 'kv' }, [
            el('span', { text: 'Road ahead' }),
            el('b', { text: `${safety.ahead.length} report(s), score ${safety.score}` }),
          ])
        : null,
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn ghost small',
          text: 'Centre on them',
          onclick: () => trip.position && mapview.flyTo(trip.position.lat, trip.position.lon, 11),
        }),
        el('button', {
          class: 'btn ghost small',
          text: 'Open full page',
          onclick: () => window.open(`/t/${trip.code}`, '_blank'),
        }),
      ]),
      events?.length
        ? el('div', { style: { marginTop: '10px' } }, [
            el('div', { class: 'label', text: 'Timeline' }),
            ...events.slice(0, 6).map((event) =>
              el('div', { class: 'event-item' }, [
                el('span', { class: 't', text: fmt.clock(event.createdAt) }),
                el('span', { text: event.message ?? event.kind }),
              ]),
            ),
          ])
        : null,
    ]),
  );
}

/* -------------------------------------------------------------------- init */
export function initTrips() {
  $('#startTripBtn').addEventListener('click', startTrip);
  $('#watchBtn').addEventListener('click', () => {
    const code = $('#watchCode').value.trim().toUpperCase();
    if (code.length !== 6) return toast('Trip codes are six characters', { tone: 'bad' });
    watchTrip(code);
  });
  $('#watchCode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#watchBtn').click();
  });

  if (state.trip) {
    renderActiveTrip(state.trip);
    startPinging();
    refreshMyTrip();
  }
  setInterval(refreshMyTrip, 30000);

  const params = new URLSearchParams(location.search);
  if (params.get('watch')) {
    $('#watchCode').value = params.get('watch').toUpperCase();
    document.getElementById('tab-trip').click();
    watchTrip(params.get('watch').toUpperCase());
  }
}

export function updateTripAvailability() {
  const ready = Boolean(state.plan);
  $('#startTripBtn').disabled = !ready || Boolean(state.trip);
  $('#tripStartHint').textContent = ready
    ? 'Your current route will be attached so watchers see the whole journey.'
    : 'Plan a route on the Plan tab to enable this.';
}
