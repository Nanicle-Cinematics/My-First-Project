'use strict';
// Pure view/component builders for the directory layout.
const { esc, initials } = require('./format');

// Inline action icons (stroke-based, inherit currentColor).
const ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

// Member avatar: photo if present, else initials chip.
function memberAvatar(m) {
  return m.photo_filename
    ? `<img class="m-avatar" src="/photos/${esc(m.photo_filename)}" alt="">`
    : `<span class="m-avatar m-avatar-fallback">${esc(initials(m.first_name + ' ' + m.last_name))}</span>`;
}

function flashHtml(flash, flashType) {
  if (!flash) return '';
  const type = flashType === 'success' ? 'success' : flashType === 'info' ? 'info' : flashType === 'error' ? 'error' : 'info';
  const role = type === 'error' ? 'alert' : 'status';
  return `<div class="toast toast-${type}" role="${role}" aria-live="polite">
    <span class="toast-msg">${esc(flash)}</span>
    <button type="button" class="toast-x" aria-label="Dismiss">×</button>
  </div>`;
}

// Gradient page banner. Title/subtitle are escaped.
function pageHero(title, subtitle) {
  return `<div class="page-hero"><div class="hero-text">
    <h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
  </div></div>`;
}
// One colored summary card. `value` may be pre-escaped HTML; `label` is escaped.
function heroStat(cls, icon, value, label) {
  return `<div class="hero-stat ${cls}">
    <div class="hs-ico">${icon}</div>
    <div><div class="hs-value">${value}</div><div class="hs-label">${esc(label)}</div></div>
  </div>`;
}
// Row of summary cards + optional right-aligned action buttons (raw HTML).
function statsRow(stats, actions = '') {
  return `<div class="members-stats">
    <div class="hero-stat-group">${stats.map((s) => heroStat(s.cls, s.icon, s.value, s.label)).join('')}</div>
    ${actions ? `<div class="hero-actions">${actions}</div>` : ''}
  </div>`;
}
// GET search/filter card. `controls` is raw HTML for any extra <select>s.
function filterCard({ q = '', placeholder = 'Search…', controls = '', name = 'q' }) {
  return `<div class="card filters-card">
    <div class="card-head"><h2>🔎 Search &amp; Filters</h2></div>
    <form class="filter-bar" method="get" data-live-search>
      <div class="search-field"><span>🔍</span>
        <input type="search" name="${esc(name)}" placeholder="${esc(placeholder)}" value="${esc(q)}"></div>
      ${controls}
      <button type="submit">Filter</button>
    </form>
  </div>`;
}
// Card wrapper for a list/table with a count badge and optional note. `inner` is raw HTML.
function listCard({ title, count, countLabel = 'items', note = '', inner }) {
  return `<div class="card list-card" data-results>
    <div class="card-head list-head">
      <h2>${title}</h2>
      <div class="list-head-right">
        ${count != null ? `<span class="count-badge">${count} ${esc(countLabel)}</span>` : ''}
        ${note ? `<span class="list-note">${esc(note)}</span>` : ''}
      </div>
    </div>
    ${inner}
  </div>`;
}

// Simple data table from headers + row arrays (cells are pre-rendered HTML).
function table(headers, rows) {
  const ths = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const trs = rows.map((r) =>
    `<tr>${r.map((c, i) => `<td data-label="${esc(headers[i] || '')}">${c == null ? '' : c}</td>`).join('')}</tr>`
  ).join('');
  return `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

// Prev / page-of / Next controls preserving the current query string.
function pager(basePath, query, page, pages) {
  if (pages <= 1) return '';
  const qs = (p) => {
    const u = new URLSearchParams(query); u.set('page', p);
    return `${basePath}?${u.toString()}`;
  };
  const prev = page > 1 ? `<a class="btn ghost" href="${qs(page - 1)}">← Prev</a>` : `<span class="btn ghost disabled">← Prev</span>`;
  const next = page < pages ? `<a class="btn ghost" href="${qs(page + 1)}">Next →</a>` : `<span class="btn ghost disabled">Next →</span>`;
  return `<div class="pager">${prev}<span class="pager-info">Page ${page} of ${pages}</span>${next}</div>`;
}

module.exports = {
  flashHtml, pageHero, heroStat, statsRow, filterCard, listCard, table, pager,
  ICON_EYE, ICON_PENCIL, ICON_TRASH, memberAvatar,
};
