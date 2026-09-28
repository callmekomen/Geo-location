/** The Reports tab, the report dialog, and everything that writes a pin. */

import { $, el, fmt, glyph, debounce, toast, escapeHtml } from './util.js';
import { api, outbox } from './api.js';
import { state, setState } from './store.js';
import { mapview, setReportMode } from './mapview.js';

let meta = null;
let pendingPoint = null;
let selectedType = 'pothole';
let selectedSeverity = 2;

/* ---------------------------------------------------------------- filters */
function buildPills() {
  const host = $('#categoryPills');
  const entries = Object.entries(meta.categories);
  host.replaceChildren(
    ...entries.map(([id, cat]) =>
      el('button', {
        class: 'pill',
        'aria-pressed': 'false',
        'data-category': id,
        onclick: (event) => {
          const btn = event.currentTarget;
          const on = btn.getAttribute('aria-pressed') === 'true';
          btn.setAttribute('aria-pressed', String(!on));
          const filters = new Set(state.filters);
          if (on) filters.delete(id);
          else filters.add(id);
          setState({ filters });
          refreshReports();
        },
      }, [el('span', { class: 'swatch', style: { background: cat.colour } }), cat.label]),
    ),
  );
}

/* ------------------------------------------------------------------ list */
function reportRow(report) {
  return el('div', { class: 'hazard-item', onclick: () => mapview.focusReport(report.id) }, [
    el('div', { class: 'hz-mark', style: { background: `${report.colour}22`, color: report.colour }, text: glyph(report.icon) }),
    el('div', { class: 'hz-body' }, [
      el('div', { class: 'hz-title', text: report.label || report.typeLabel }),
      el('div', {
        class: 'hz-meta',
        text: `${report.typeLabel} · ${report.road ?? report.place ?? ''} · ${fmt.ago(report.createdAt)}`,
      }),
      report.note ? el('div', { class: 'hz-note', text: report.note }) : null,
    ]),
    el('div', { class: 'hz-dist' }, [
      el('div', { text: `${Math.round(report.confidence * 100)}%` }),
      el('div', { style: { color: 'var(--text-faint)', fontSize: '10px' }, text: 'confidence' }),
    ]),
  ]);
}

export function renderReportList() {
  const host = $('#reportsList');
  const reports = state.reports;
  $('#reportsCountMeta').textContent = `${reports.length} shown`;
  $('#reportsScope').textContent = state.reportsScope ?? 'map area';
  if (!reports.length) {
    host.replaceChildren(
      el('div', { class: 'empty', html: 'No reports in this part of the map.<br>Zoom out, or be the first to add one.' }),
    );
    return;
  }
  host.replaceChildren(el('div', { class: 'card' }, reports.slice(0, 60).map(reportRow)));
}

/** A plain-language description of what the list is currently showing. */
function describeScope() {
  const zoom = mapview.map?.getZoom?.() ?? 7;
  const area =
    zoom >= 13 ? 'this street' : zoom >= 11 ? 'this neighbourhood' : zoom >= 8 ? 'this area' : zoom >= 6 ? 'this region' : 'the whole country';
  if (!state.filters.size || !meta) return area;
  const names = [...state.filters].map((id) => meta.categories[id]?.label ?? id);
  return `${area} · ${names.join(', ').toLowerCase()}`;
}

export const refreshReports = debounce(async () => {
  try {
    const categories = [...state.filters].join(',');
    const { reports } = await api.reports({ bbox: mapview.bboxString(), categories, limit: 600 });
    setState({ reports, reportsScope: describeScope() });
    mapview.renderReports(reports, { onVote: handleVote });
    renderReportList();
    const chip = $('#chipReportsCount');
    if (chip) chip.textContent = reports.length;
  } catch (error) {
    if (!navigator.onLine) return;
    console.warn('report refresh failed', error);
  }
}, 320);

async function handleVote(report, vote) {
  try {
    const { report: updated } = await api.vote(report.id, vote);
    setState({ reports: state.reports.map((r) => (r.id === updated.id ? updated : r)) });
    mapview.renderReports(state.reports, { onVote: handleVote });
    renderReportList();
    toast(vote === 'confirm' ? 'Thanks — confirmation recorded' : 'Thanks — marked as no longer there', { tone: 'good' });
  } catch (error) {
    toast(error.message ?? 'Could not record that vote', { tone: 'bad' });
  }
}

/* ---------------------------------------------------------------- dialog */
function buildTypeGrid() {
  const grid = $('#typeGrid');
  grid.replaceChildren(
    ...Object.entries(meta.reportTypes).map(([id, type]) =>
      el('button', {
        type: 'button',
        class: 'type-opt',
        'data-type': id,
        'aria-pressed': String(id === selectedType),
        title: type.hint,
        onclick: () => selectType(id),
      }, [el('span', { class: 'glyph', text: glyph(type.icon) }), type.label]),
    ),
  );
}

function selectType(id) {
  selectedType = id;
  for (const button of $('#typeGrid').children) {
    button.setAttribute('aria-pressed', String(button.dataset.type === id));
  }
  const type = meta.reportTypes[id];
  $('#fuelFields').hidden = type.category !== 'fuel';
  selectedSeverity = type.severity || 1;
  for (const button of $('#severityRow').children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.severity) === selectedSeverity));
  }
  const hint = $('#reportNoteInput');
  hint.placeholder = type.hint ?? 'Any useful detail…';
}

export async function openReportDialog(point) {
  pendingPoint = point;
  const dialog = $('#reportDialog');
  $('#reportLocation').textContent = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} — locating…`;
  $('#reportLabelInput').value = '';
  $('#reportNoteInput').value = '';
  $('#fuelPrice').value = '';
  $('#fuelQueue').value = '';
  selectType(selectedType);
  dialog.showModal();

  try {
    const place = await api.reverse(point.lat, point.lon);
    $('#reportLocation').textContent = place.road ? `${place.road} — ${place.label}` : place.label;
  } catch {
    $('#reportLocation').textContent = `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
  }
}

async function submitReport(event) {
  event.preventDefault();
  if (!pendingPoint) return;
  const payload = {
    type: selectedType,
    lat: pendingPoint.lat,
    lon: pendingPoint.lon,
    severity: selectedSeverity,
    label: $('#reportLabelInput').value.trim() || undefined,
    note: $('#reportNoteInput').value.trim() || undefined,
    reporter: $('#reporterInput').value.trim() || undefined,
  };
  const price = $('#fuelPrice').value;
  const queue = $('#fuelQueue').value;
  if (meta.reportTypes[selectedType].category === 'fuel' && (price || queue)) {
    payload.meta = { ...(price ? { price: Number(price) } : {}), ...(queue ? { queue } : {}) };
  }

  $('#reportSubmit').disabled = true;
  try {
    const result = await api.createReport(payload);
    $('#reportDialog').close();
    setReportMode(false);
    if (result.queued) {
      toast('Saved offline — will publish when you reconnect', { tone: '', detail: `${outbox.size()} report(s) waiting` });
    } else {
      toast(result.deduped ? 'Matched an existing report — counted as a confirmation' : 'Report posted. Thank you.', { tone: 'good' });
      refreshReports();
    }
    localStorage.setItem('nr.reporter', $('#reporterInput').value.trim());
  } catch (error) {
    toast(error.message ?? 'Could not post that report', { tone: 'bad' });
  } finally {
    $('#reportSubmit').disabled = false;
    pendingPoint = null;
  }
}

/* -------------------------------------------------------------------- init */
export function initReports(appMeta) {
  meta = appMeta;
  buildPills();
  buildTypeGrid();
  $('#reporterInput').value = localStorage.getItem('nr.reporter') ?? '';

  for (const button of $('#severityRow').children) {
    button.addEventListener('click', () => {
      selectedSeverity = Number(button.dataset.severity);
      for (const other of $('#severityRow').children) {
        other.setAttribute('aria-pressed', String(other === button));
      }
    });
  }

  $('#reportForm').addEventListener('submit', submitReport);
  $('#reportCancel').addEventListener('click', () => $('#reportDialog').close());

  $('#addReportBtn').addEventListener('click', () => {
    if (state.position) openReportDialog({ lat: state.position.lat, lon: state.position.lon });
    else {
      setReportMode(true);
      toast('Tap the spot on the map', { detail: 'Or turn on location to report where you are' });
    }
  });

  mapview.onReportPoint = (point) => {
    setReportMode(false);
    openReportDialog(point);
  };

  mapview.map.on('moveend zoomend', refreshReports);
}

/** Called by the live stream when someone else posts a report. */
export function ingestLiveReport(report) {
  if (state.reports.some((r) => r.id === report.id)) {
    setState({ reports: state.reports.map((r) => (r.id === report.id ? report : r)) });
  } else {
    setState({ reports: [report, ...state.reports] });
  }
  mapview.renderReports(state.reports, { onVote: handleVote });
  renderReportList();
}

export { handleVote };
