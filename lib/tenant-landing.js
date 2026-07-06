'use strict';
// Phase 8f: the public marketing landing page (unauthenticated GET /).
// Adapted, not a verbatim port — see the two real differences from the
// original (server.js's publicLandingPage):
// 1. CTAs link straight to /signup (already-built instant self-service
//    signup) instead of the original's /trial-signup lead-capture form
//    ("tell us your details, we'll email you"). That flow existed because
//    provisioning was a manual per-church deploy step in the old model;
//    here signup already creates a working church immediately, so a lead
//    form would be a strictly worse path to the same result.
// 2. Pricing is 2-tier (Free / Pro) matching the actual plan model
//    (routes-pg/settings.js's PLAN_LIMITS), not the original's stale
//    3-tier Starter/Pro/Enterprise copy with a monthly/yearly toggle that
//    has no corresponding billing system on this stack.
//
// Design system (styles.css, header/footer markup, section structure) is
// reused as-is from the original.

const { esc } = require('./format');

const CHURCH_NAME = process.env.CHURCH_NAME || 'Church Manager';

function landingPage(loggedIn) {
  const topCta = loggedIn ? { href: '/', label: 'Go to dashboard' } : { href: '/login', label: 'Sign in' };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CHURCH_NAME)}</title>
<meta name="description" content="Manage members, attendance, finance and church communication in one workspace.">
<script>(function(){try{var saved=localStorage.getItem('theme');var mq=window.matchMedia&&matchMedia('(prefers-color-scheme:dark)');document.documentElement.setAttribute('data-theme',saved||(mq&&mq.matches?'dark':'light'));if(mq){var sync=function(){try{if(localStorage.getItem('theme'))return;}catch(e){}document.documentElement.setAttribute('data-theme',mq.matches?'dark':'light');};if(mq.addEventListener)mq.addEventListener('change',sync);else if(mq.addListener)mq.addListener(sync);}}catch(e){}})();</script>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body class="public-landing">
  <header class="public-nav">
    <a class="public-brand" href="/">
      <img src="/static/logo.png" alt="">
      <span><strong>${esc(CHURCH_NAME)}</strong><small>Ministry operations</small></span>
    </a>
    <button class="public-menu-toggle" type="button" aria-expanded="false" aria-controls="public-menu">
      <span></span><span></span><span></span><b class="sr-only">Open navigation</b>
    </button>
    <nav id="public-menu">
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="/signup">Get started</a>
      <a class="public-login" href="${topCta.href}">${topCta.label}</a>
    </nav>
  </header>

  <main>
    <section class="landing-hero">
      <div class="landing-hero-copy">
        <div class="landing-kicker"><i></i> Built for modern ministry teams</div>
        <h1>Lead the ministry.<br><em>We’ll organize the rest.</em></h1>
        <p>One calm, secure workspace for members, attendance, giving, communications and the reports that keep your church moving.</p>
        <div class="landing-actions">
          <a class="btn primary" href="/signup">Start your free workspace <span>→</span></a>
          <a class="btn ghost" href="#product-preview">See the product</a>
        </div>
        <div class="landing-trust" aria-label="Platform highlights">
          <span><b>✓</b> Free to start</span>
          <span><b>✓</b> No card required</span>
          <span><b>✓</b> Private church workspace</span>
        </div>
      </div>
      <div class="product-window" id="product-preview" aria-label="Church Manager dashboard preview">
        <div class="product-window-bar"><i></i><i></i><i></i><span>Sunday operations overview</span></div>
        <div class="product-window-body">
          <aside>
            <div class="preview-brand">CM</div>
            <b></b><b></b><b></b><b></b><b></b>
          </aside>
          <div class="preview-main">
            <div class="preview-head">
              <div><small>GOOD MORNING</small><strong>Ministry overview</strong></div>
              <span>5 Jul 2026</span>
            </div>
            <div class="preview-stats">
              <article><small>Members</small><strong>1,248</strong><em>+18 this month</em></article>
              <article><small>Check-ins</small><strong>386</strong><em>Last Sunday</em></article>
              <article><small>Giving</small><strong>GH₵ 24.8k</strong><em>July to date</em></article>
            </div>
            <div class="preview-grid">
              <article class="preview-chart">
                <div><strong>Weekly attendance</strong><small>Last 6 weeks</small></div>
                <div class="chart-bars"><i></i><i></i><i></i><i></i><i></i><i></i></div>
              </article>
              <article class="preview-activity">
                <strong>Today</strong>
                <p><i></i><span><b>Morning service</b><small>8:30 AM · Main sanctuary</small></span></p>
                <p><i></i><span><b>Youth meeting</b><small>4:00 PM · Hall B</small></span></p>
              </article>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="public-proof" aria-label="Platform assurances">
      <div><strong>Purpose-built</strong><span>For pastors, secretaries and treasurers</span></div>
      <div><strong>Finance-ready</strong><span>Ghana cedi reporting and audit history</span></div>
      <div><strong>Secure by design</strong><span>Every church has a private workspace</span></div>
    </section>

    <section id="features" class="public-section">
      <div class="section-head">
        <span>Platform</span>
        <h2>Everything your office needs in one place.</h2>
      </div>
      <div class="public-feature-grid">
        <article><span>01</span><h3>Members</h3><p>Profiles, contacts, Bible classes, and organizations.</p></article>
        <article><span>02</span><h3>Attendance</h3><p>Track services, events and weekly trends from one view.</p></article>
        <article><span>03</span><h3>Finance</h3><p>Record offerings, expenses and fund balances cleanly.</p></article>
        <article><span>04</span><h3>Reports</h3><p>Review income, day-born collections and membership without hunting through menus.</p></article>
      </div>
    </section>

    <section id="pricing" class="public-section pricing-section">
      <div class="section-head">
        <span>Pricing</span>
        <h2>Start free. Upgrade when you're ready.</h2>
      </div>
      <div class="public-plan-grid">
        <article class="public-plan">
          <div class="plan-top"><span>Free</span></div>
          <div class="public-price">GH₵ 0</div>
          <p>Try the system with your church's own data — up to 2 users.</p>
          <ul><li>Members & attendance</li><li>Finance basics</li><li>Up to 2 users</li></ul>
          <a class="btn ghost" href="/signup">Create your church</a>
        </article>
        <article class="public-plan featured">
          <div class="plan-badge">Recommended</div>
          <h3>Pro</h3>
          <p>For active churches that need more staff accounts and full reporting.</p>
          <div class="public-price">Contact us</div>
          <ul><li>Unlimited users</li><li>Full reports</li><li>Priority support</li></ul>
          <a class="btn primary" href="/signup">Create your church</a>
        </article>
      </div>
    </section>
  </main>
  <footer class="public-footer">
    <div><strong>${esc(CHURCH_NAME)}</strong><span>Less administration. More ministry.</span></div>
    <nav><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="/login">Sign in</a><a href="/signup">Get started</a></nav>
  </footer>
  <script>
    (function () {
      var button = document.querySelector('.public-menu-toggle');
      var menu = document.getElementById('public-menu');
      if (!button || !menu) return;
      button.addEventListener('click', function () {
        var open = document.body.classList.toggle('public-menu-open');
        button.setAttribute('aria-expanded', String(open));
      });
      menu.addEventListener('click', function (event) {
        if (event.target.tagName === 'A') {
          document.body.classList.remove('public-menu-open');
          button.setAttribute('aria-expanded', 'false');
        }
      });
      // The toggle button and mobile menu only exist below the 820px
      // breakpoint (see .public-menu-toggle in styles.css). Reset the open
      // state when crossing into the desktop layout, so a resize back down
      // always starts closed instead of showing a stale open state left
      // over from before the resize.
      var desktopQuery = window.matchMedia && matchMedia('(min-width: 821px)');
      if (desktopQuery) {
        var resetOnDesktop = function () {
          if (!desktopQuery.matches) return;
          document.body.classList.remove('public-menu-open');
          button.setAttribute('aria-expanded', 'false');
        };
        if (desktopQuery.addEventListener) desktopQuery.addEventListener('change', resetOnDesktop);
        else if (desktopQuery.addListener) desktopQuery.addListener(resetOnDesktop);
      }
    })();
  </script>
</body>
</html>`;
}

module.exports = { landingPage };
