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

const CHURCH_NAME = process.env.CHURCH_NAME || 'Church Manager';

function landingPage(loggedIn) {
  const topCta = loggedIn ? { href: '/', label: 'Go to dashboard' } : { href: '/login', label: 'Sign in' };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${CHURCH_NAME}</title>
<meta name="description" content="Manage members, attendance, finance and church communication in one workspace.">
<script>(function(){try{var mq=window.matchMedia&&matchMedia('(prefers-color-scheme:dark)');function apply(){document.documentElement.setAttribute('data-theme',mq&&mq.matches?'dark':'light');}try{localStorage.removeItem('theme');}catch(e){}apply();if(mq){if(mq.addEventListener)mq.addEventListener('change',apply);else if(mq.addListener)mq.addListener(apply);}}catch(e){}})();</script>
<link rel="stylesheet" href="/static/styles.css">
</head>
<body class="public-landing">
  <header class="public-nav">
    <a class="public-brand" href="/">
      <img src="/static/logo.png" alt="">
      <span>${CHURCH_NAME}</span>
    </a>
    <nav>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="/signup">Get started</a>
      <a class="public-login" href="${topCta.href}">${topCta.label}</a>
    </nav>
  </header>

  <main>
    <section class="landing-hero">
      <div class="landing-kicker">For church admin teams</div>
      <h1>Run your church like a pro</h1>
      <p>Keep members, attendance, finance, communications and reports in one clean workspace built for pastors, secretaries and treasurers.</p>
      <div class="landing-actions">
        <a class="btn primary" href="/signup">Create your church's workspace</a>
        <a class="btn ghost" href="#pricing">View pricing</a>
      </div>
      <div class="landing-chips" aria-label="Platform highlights">
        <span>Free to start</span>
        <span>Members & attendance</span>
        <span>Finance & reports</span>
        <span>Your own private workspace</span>
      </div>
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
    <a href="/login">Sign in</a>
    <a href="/signup">Get started</a>
  </footer>
</body>
</html>`;
}

module.exports = { landingPage };
