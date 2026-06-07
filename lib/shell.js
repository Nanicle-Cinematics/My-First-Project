'use strict';
// The page shell (full HTML document + client scripts) and the auth-screen
// shell. Built as a factory so the stateful dependencies are injected rather
// than reached for as module globals.
module.exports.createShell = function createShell(deps) {
  const { CHURCH_NAME, NAV, esc, initials, flashHtml, scriptureOfDay, listBackups } = deps;

  function layout({ title, subtitle, subtitleHtml, body, active, flash, flashType, user, bare, noHeader }) {
    if (bare) {
      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(CHURCH_NAME)}</title>
<script>(function(){try{var t=localStorage.getItem('theme')||(window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<div class="auth-shell">
  <div class="auth-layout">
    <section class="auth-intro" aria-label="Church management sign-in">
      <img class="auth-logo" src="/static/methodist-ghana-logo.svg" alt="The Methodist Church Ghana">
      <div>
        <div class="auth-kicker">Refined Ministry Operations</div>
        <h2>${esc(CHURCH_NAME)}</h2>
        <p>Secure access for members, giving, services, reports and church operations.</p>
      </div>
    </section>
    <div class="auth-card">
      <div class="brand-mini">
        <img class="brand-mini-logo" src="/static/methodist-ghana-logo.svg" alt="">
        ${esc(CHURCH_NAME)}
      </div>
      <h1>${esc(title)}</h1>
      ${flashHtml(flash, flashType)}
      ${body}
    </div>
  </div>
</div>
</body></html>`;
    }
    const isAdmin = user && user.role === 'admin';
    const visibleNav = NAV.filter((item) => !item[3] || (item[3] === 'admin' && isAdmin));
    const navSections = [
      { label: 'Dashboard', hrefs: ['/'] },
      { label: 'Members', hrefs: ['/members', '/attendance', '/bible-classes', '/organizations'] },
      { label: 'Finance', hrefs: ['/finance', '/inventory'] },
      { label: 'Services / Events', hrefs: ['/events', '/preaching', '/sacraments', '/communications'] },
      { label: 'Reports', hrefs: ['/reports', '/operations', '/backups', '/errors', '/security/audit'] },
      { label: 'Settings', hrefs: ['/users', '/settings'] },
    ];
    const activeItem = visibleNav.find(([href]) => href === active);
    const breadcrumb = activeItem ? activeItem[1] : title;
    const navHtml = navSections.map((section) => {
      const links = visibleNav.filter(([href]) => section.hrefs.includes(href));
      if (!links.length) return '';
      return `<div class="nav-section">
        <div class="nav-section-label">${esc(section.label)}</div>
        ${links.map(([href, label, icon]) => {
          const cls = href === active ? 'active' : '';
          return `<a class="${cls}" href="${href}"><span class="ico">${icon}</span><span class="nav-text">${esc(label)}</span></a>`;
        }).join('')}
      </div>`;
    }).join('');
    const verse = scriptureOfDay();
    const userName = user ? (user.display_name || user.username) : '';
    const userInitials = initials(userName);
    const roleLabel = user ? ({ admin: 'Administrator', editor: 'Editor', viewer: 'Viewer' }[user.role] || 'Viewer') : '';
    const roleShort = user ? ({ admin: 'Owner', editor: 'Editor', viewer: 'Viewer' }[user.role] || 'Viewer') : '';
    const backup = (() => {
      try {
        const latest = listBackups()[0];
        if (!latest) return 'never';
        return latest.mtime.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      } catch (_) { return '—'; }
    })();
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(CHURCH_NAME)}</title>
<script>(function(){try{var t=localStorage.getItem('theme')||(window.matchMedia&&matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="app">
  <aside class="sidebar" id="app-nav">
    <div class="brand">
      <img class="brand-logo-img" src="/static/methodist-ghana-logo.svg" alt="" aria-hidden="true">
      <div>
        <div class="name">${esc(CHURCH_NAME)}</div>
        <div class="tag">Management System</div>
      </div>
    </div>
    <nav>${navHtml}</nav>
    <a class="sidebar-user" href="/profile">
      <div class="avatar">${esc(userInitials)}</div>
      <div class="sidebar-user-meta">
        <div class="name">${esc(userName)}</div>
        <div class="role-badge">${esc(roleShort)}</div>
      </div>
    </a>
    <div class="scripture">
      <div class="title">📖 Scripture of the Day</div>
      <blockquote>“${esc(verse[0])}”</blockquote>
      <cite>– ${esc(verse[1])}</cite>
    </div>
    <form class="drawer-signout" method="post" action="/logout">
      <button type="submit">Sign out</button>
    </form>
  </aside>
  <div class="scrim" hidden></div>
  <div class="main">
    <div class="topbar">
      <button class="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="app-nav">
        <span class="bars"></span>
      </button>
      <div class="topbar-title">
        <div class="breadcrumb">Home / ${esc(breadcrumb)}</div>
        <div class="current">${esc(title)}</div>
      </div>
      <form class="search" action="/members" method="get">
        <span>🔍</span>
        <input type="search" name="q" placeholder="Search members, phone, email…">
      </form>
      <div class="right">
        <button class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">🌙</button>
        <a class="bell" href="/communications" title="Notifications" aria-label="Notifications">🔔<span class="badge">1</span></a>
        <a class="who" href="/profile">
          <div class="avatar">${esc(userInitials)}</div>
          <div>
            <div class="name">${esc(userName)}</div>
            <div class="role">${esc(roleLabel)}</div>
          </div>
        </a>
        <form method="post" action="/logout"><button class="sign-out" type="submit">Sign out</button></form>
      </div>
    </div>
    <main class="page" id="main" tabindex="-1">
      ${flashHtml(flash, flashType)}
      ${noHeader ? '' : `<h1>${esc(title)}</h1>${subtitleHtml ? `<p class="subtitle">${subtitleHtml}</p>` : (subtitle ? `<p class="subtitle">${esc(subtitle)}</p>` : '')}`}
      ${body}
      <div class="print-footer">
        Printed by <strong>${esc(userName)}</strong>
        · <span id="print-ts">${new Date().toLocaleString('en-GB')}</span>
        · ${esc(CHURCH_NAME)}
      </div>
      <script>
        window.addEventListener('beforeprint', function () {
          var el = document.getElementById('print-ts');
          if (el) el.textContent = new Date().toLocaleString('en-GB');
        });
        // Mark every required field with a red asterisk right after its label text.
        document.querySelectorAll('[required]').forEach(function (r) {
          var lbl = r.closest('label');
          if (!lbl || lbl.querySelector('.req-star')) return;
          var star = document.createElement('span');
          star.className = 'req-star';
          star.textContent = ' *';
          var firstText = null;
          for (var i = 0; i < lbl.childNodes.length; i++) {
            var n = lbl.childNodes[i];
            if (n.nodeType === 3 && n.textContent.trim()) { firstText = n; break; }
          }
          if (firstText) lbl.insertBefore(star, firstText.nextSibling);
          else r.parentNode.insertBefore(star, r);
        });
        // Confirm before saving on every create/edit form (class="form").
        // Forms that already have an onsubmit confirm (e.g. archive) opt out.
        document.querySelectorAll('form.form').forEach(function (f) {
          if (f.getAttribute('onsubmit')) return;
          if (f.dataset.noConfirm === '1') return;
          f.addEventListener('submit', function (e) {
            if (!window.confirm('Save these changes?')) e.preventDefault();
          });
        });

        // Dark-mode toggle (persisted in localStorage).
        (function () {
          var root = document.documentElement;
          var btn = document.querySelector('.theme-toggle');
          function paint(t) { if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙'; }
          paint(root.getAttribute('data-theme') || 'light');
          if (btn) btn.addEventListener('click', function () {
            var t = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            root.setAttribute('data-theme', t);
            try { localStorage.setItem('theme', t); } catch (e) {}
            paint(t);
          });
        })();

        // Mobile slide-in navigation drawer.
        (function () {
          var app = document.querySelector('.app');
          var toggle = document.querySelector('.nav-toggle');
          var scrim = document.querySelector('.scrim');
          if (!app || !toggle || !scrim) return;
          function setOpen(open) {
            app.classList.toggle('nav-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            scrim.hidden = !open;
            document.body.style.overflow = open ? 'hidden' : '';
          }
          toggle.addEventListener('click', function () {
            setOpen(!app.classList.contains('nav-open'));
          });
          scrim.addEventListener('click', function () { setOpen(false); });
          app.querySelectorAll('.sidebar nav a').forEach(function (a) {
            a.addEventListener('click', function () { setOpen(false); });
          });
          document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') setOpen(false);
          });
        })();

        // Clickable dashboard cards. Native controls and inner links keep their own behavior.
        (function () {
          document.querySelectorAll('[data-card-href]').forEach(function (card) {
            if (card.dataset.cardInit === '1') return;
            card.dataset.cardInit = '1';
            if (!card.hasAttribute('role')) card.setAttribute('role', 'link');
            if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '0');
            function shouldIgnore(target) {
              return !!target.closest('a, button, input, select, textarea, label, summary, form, [data-no-card-click]');
            }
            function go() {
              var href = card.getAttribute('data-card-href');
              if (href) window.location.href = href;
            }
            card.addEventListener('click', function (e) {
              if (shouldIgnore(e.target)) return;
              go();
            });
            card.addEventListener('keydown', function (e) {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              if (shouldIgnore(e.target)) return;
              e.preventDefault();
              go();
            });
          });
        })();

        // On phones, collapse wide tables to key fields with a per-row toggle.
        (function () {
          var KEY_COLS = 2; // columns shown before "Show details"
          var mq = window.matchMedia('(max-width: 640px)');
          function enhance() {
            if (!mq.matches) return;
            document.querySelectorAll('table.data-table:not(.members-table) tbody tr').forEach(function (tr) {
              if (tr.dataset.rEnhanced) return;
              var tds = tr.querySelectorAll('td');
              if (tds.length <= KEY_COLS) { tr.dataset.rEnhanced = '1'; return; }
              var hasExtra = false;
              for (var i = KEY_COLS; i < tds.length; i++) {
                if (tds[i].textContent.trim() !== '') hasExtra = true;
                tds[i].classList.add('td-extra');
              }
              tr.dataset.rEnhanced = '1';
              if (!hasExtra) return;
              var cell = document.createElement('td');
              cell.className = 'row-expand-cell';
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'row-expand';
              btn.textContent = 'Show details';
              btn.addEventListener('click', function () {
                var open = tr.classList.toggle('is-open');
                btn.textContent = open ? 'Hide details' : 'Show details';
              });
              cell.appendChild(btn);
              tr.appendChild(cell);
            });
          }
          enhance();
          if (mq.addEventListener) mq.addEventListener('change', enhance);
          window.addEventListener('resize', enhance);
          document.addEventListener('results:updated', enhance);
        })();

        // Toast notifications: auto-dismiss + manual close.
        function initToasts() {
          document.querySelectorAll('.toast:not([data-init])').forEach(function (t) {
            t.setAttribute('data-init', '1');
            var x = t.querySelector('.toast-x');
            function dismiss() { t.classList.add('toast-hide'); setTimeout(function () { t.remove(); }, 250); }
            if (x) x.addEventListener('click', dismiss);
            setTimeout(dismiss, 5000);
          });
        }
        initToasts();

        // Live search: debounce GET filter forms and swap the results region.
        (function () {
          document.querySelectorAll('form[data-live-search]').forEach(function (form) {
            var timer;
            function run() {
              var params = new URLSearchParams(new FormData(form));
              var url = (form.getAttribute('action') || location.pathname) + '?' + params.toString();
              var cur = document.querySelector('[data-results]');
              if (cur) cur.classList.add('is-loading');
              fetch(url, { headers: { 'X-Requested-With': 'fetch' } })
                .then(function (r) { return r.text(); })
                .then(function (html) {
                  var doc = new DOMParser().parseFromString(html, 'text/html');
                  var next = doc.querySelector('[data-results]');
                  var now = document.querySelector('[data-results]');
                  if (next && now) now.replaceWith(next);
                  history.replaceState(null, '', url);
                  document.dispatchEvent(new Event('results:updated'));
                })
                .catch(function () { if (cur) cur.classList.remove('is-loading'); });
            }
            form.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 300); });
            form.addEventListener('change', function () { clearTimeout(timer); timer = setTimeout(run, 120); });
          });
        })();

        // Bulk selection (Members). Re-binds after live-search swaps.
        function initBulk() {
          var table = document.querySelector('table[data-bulk]');
          var bar = document.querySelector('.bulk-bar');
          if (!table || !bar) return;
          var idsField = bar.querySelector('input[name="member_ids"]');
          var countEl = bar.querySelector('.bulk-count');
          var all = table.querySelector('.bulk-all');
          function boxes() { return Array.prototype.slice.call(table.querySelectorAll('.bulk-box')); }
          function update() {
            var ids = boxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
            idsField.value = ids.join(',');
            countEl.textContent = ids.length;
            bar.classList.toggle('show', ids.length > 0);
          }
          if (all && !all.dataset.init) {
            all.dataset.init = '1';
            all.addEventListener('change', function () {
              boxes().forEach(function (b) { b.checked = all.checked; });
              update();
            });
          }
          if (!table.dataset.bulkInit) {
            table.dataset.bulkInit = '1';
            table.addEventListener('change', function (e) {
              if (e.target.classList && e.target.classList.contains('bulk-box')) update();
            });
          }
          update();
        }
        initBulk();
        document.addEventListener('results:updated', function () { initBulk(); initToasts(); });
      </script>
    </main>
    <footer class="footer">
      <div>© ${new Date().getFullYear()} ${esc(CHURCH_NAME)}. All rights reserved.</div>
      <div class="status">
        <span>Last backup: ${esc(backup)}</span>
        <span class="status"><span class="dot"></span> System Online</span>
      </div>
    </footer>
  </div>
</div>
</body></html>`;
  }

  function authPage(title, body, flash) {
    return layout({ title, body, bare: true, flash, active: null, user: null });
  }

  return { layout, authPage };
};
