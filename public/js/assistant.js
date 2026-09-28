/** The chat assistant panel. */

import { $, el, toast } from './util.js';
import { api } from './api.js';
import { state, activeRoute } from './store.js';

const history = [];

const SUGGESTIONS = [
  'How far from Ikeja to Benin City?',
  'Any flooding near me?',
  'Where can I buy fuel?',
  'What are the current hotspots?',
  'Is it safe to travel at night?',
];

function bubble(role, text) {
  const node = el('div', { class: `msg ${role}`, text });
  $('#assistantLog').append(node);
  $('#assistantLog').scrollTop = $('#assistantLog').scrollHeight;
  return node;
}

function buildContext() {
  const route = activeRoute();
  const plan = state.plan;
  return {
    position: state.position ? { lat: state.position.lat, lon: state.position.lon } : null,
    route:
      route && plan
        ? {
            from: plan.from.label,
            to: plan.to.label,
            fromLat: plan.from.lat,
            fromLon: plan.from.lon,
            distanceM: route.distanceM,
            durationS: route.durationS,
            safety: route.safety,
            hazards: route.hazards.slice(0, 12),
          }
        : null,
  };
}

async function send(text) {
  const message = text.trim();
  if (!message) return;
  $('#assistantInput').value = '';
  bubble('user', message);
  history.push({ role: 'user', content: message });
  const thinking = bubble('bot thinking', 'Reading the map…');

  try {
    const answer = await api.assistant({ message, context: buildContext(), history: history.slice(-8) });
    thinking.remove();
    bubble('bot', answer.reply);
    history.push({ role: 'assistant', content: answer.reply });
    $('#assistantMode').textContent =
      answer.mode === 'builtin' || answer.mode === 'builtin-fallback' ? 'answering from live data' : `via ${answer.mode}`;
  } catch (error) {
    thinking.remove();
    bubble('bot', error.message ?? 'Could not reach the assistant. Try again in a moment.');
  }
}

export function initAssistant(meta) {
  const panel = $('#assistant');
  const fab = $('#assistantFab');

  const open = () => {
    panel.hidden = false;
    fab.hidden = true;
    $('#assistantInput').focus();
    if (!$('#assistantLog').childElementCount) {
      bubble(
        'bot',
        'I read this map directly — routes, live road reports, fuel prices and trip codes. Ask me anything about your journey.',
      );
    }
  };
  const close = () => {
    panel.hidden = true;
    fab.hidden = false;
  };

  fab.addEventListener('click', open);
  $('#assistantClose').addEventListener('click', close);
  $('#assistantForm').addEventListener('submit', (event) => {
    event.preventDefault();
    send($('#assistantInput').value);
  });

  $('#assistantSuggest').replaceChildren(
    ...SUGGESTIONS.map((text) => el('button', { type: 'button', text, onclick: () => send(text) })),
  );

  if (meta?.assistant?.mode && meta.assistant.mode !== 'builtin') {
    $('#assistantMode').textContent = `via ${meta.assistant.mode}`;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
    if (event.key === '/' && document.activeElement === document.body) {
      event.preventDefault();
      open();
    }
  });
}

export { send as askAssistant };
