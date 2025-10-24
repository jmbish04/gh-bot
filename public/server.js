const API_BASE = '';

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    const message = `Request to ${path} failed with status ${response.status}`;
    throw new Error(message);
  }
  return response.json();
}

function formatTimestamp(value) {
  if (!value) {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

async function getRecentActivity() {
  const data = await fetchJson('/api/dashboard/recent-activity');
  return Array.isArray(data.events) ? data.events : [];
}

async function getRepositories() {
  const data = await fetchJson('/api/dashboard/repositories');
  return Array.isArray(data.repositories) ? data.repositories : [];
}

async function getEventTypes() {
  const data = await fetchJson('/api/dashboard/event-types');
  return Array.isArray(data.event_types) ? data.event_types : [];
}

async function getRepoEvents(owner, repo) {
  const data = await fetchJson(`/api/repository/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  return data;
}

async function getEventTypeEvents(type) {
  const data = await fetchJson(`/api/event-type/${encodeURIComponent(type)}`);
  return data;
}

async function getEventDetail(deliveryId) {
  const data = await fetchJson(`/api/event/${encodeURIComponent(deliveryId)}`);
  return data;
}

window.dashboardApi = {
  getRecentActivity,
  getRepositories,
  getEventTypes,
  getRepoEvents,
  getEventTypeEvents,
  getEventDetail,
  formatTimestamp,
};
