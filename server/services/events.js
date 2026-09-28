/**
 * Server-sent events bus.
 *
 * Every connected map gets new reports and trip pings pushed to it, so a pin
 * dropped in Onitsha shows up in Lagos without anyone hitting refresh.
 */

import { randomUUID } from 'node:crypto';

const clients = new Map();
const RECENT_LIMIT = 50;
const recent = [];

export function addClient(res, { topics = ['*'] } = {}) {
  const id = randomUUID();
  clients.set(id, { res, topics: new Set(topics) });
  return id;
}

export function removeClient(id) {
  clients.delete(id);
}

export function clientCount() {
  return clients.size;
}

function matches(client, topic) {
  return client.topics.has('*') || client.topics.has(topic) || client.topics.has(topic.split(':')[0]);
}

/**
 * Broadcast an event to every interested listener.
 * @param {string} topic e.g. "report:new", "trip:ping", "trip:sos"
 */
export function publish(topic, payload) {
  const event = { topic, at: new Date().toISOString(), payload };
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();

  const chunk = `event: ${topic}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const [id, client] of clients) {
    if (!matches(client, topic)) continue;
    try {
      client.res.write(chunk);
    } catch {
      clients.delete(id);
    }
  }
  return event;
}

export function recentEvents(limit = 20) {
  return recent.slice(-limit).reverse();
}

export function heartbeat() {
  for (const [id, client] of clients) {
    try {
      client.res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clients.delete(id);
    }
  }
}
