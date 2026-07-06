'use strict';
// Phase 8a: login/signup HTML pages. Built directly against the already-
// working lib/auth.js/lib/provision.js (email-based, not a port of
// server.js's username-based /login+/setup — the backend logic differs,
// only the visual authPage() shell/CSS is shared). POST /login, POST
// /signup, POST /logout live in lib/tenant-http.js (content-negotiated
// with the existing JSON API — see that file's comment) and call the
// render* helpers here on validation/auth failure.
//
// Forgot-password is deferred — lib/auth.js has no reset-token flow yet;
// an admin can reset a teammate's password via /users once that module is
// HTML-ported (see the Phase 8 plan).

const { esc } = require('./format');
const { authPage } = require('./tenant-shell');
const {
  createPasswordResetToken, findValidResetToken, resetPasswordWithToken,
  createEmailVerificationToken, verifyEmailToken, previewEmailVerificationToken,
} = require('./auth');
const { tenantDb } = require('./tenant');
const { sendEmailEach } = require('./delivery');
const asyncHandler = require('./async-handler');
const { createRateLimiter } = require('./rate-limit');

// Unlike /login, /signup, /login/mfa (rate-limited in tenant-http.js), these
// two endpoints send email and previously had no throttle at all — anyone
// could spam either for a target address with no rate limit, an
// email-bombing vector.
const forgotRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  key: (req) => `${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`,
});
const resendVerificationRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000, max: 10,
  key: (req) => `${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`,
});

function loginBody({ error, email } = {}) {
  return `
    <form class="form auth-form" method="post" action="/login">
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="wide">Email<input type="email" name="email" required autofocus autocomplete="username" value="${esc(email || '')}"></label>
      <label class="wide">Password<input type="password" name="password" required autocomplete="current-password"></label>
      <div class="actions"><button type="submit">Sign in</button></div>
      <p class="auth-aux"><a href="/forgot">Forgot password?</a></p>
      <p class="auth-aux">Don't have a church set up yet? <a href="/signup">Create one</a></p>
    </form>`;
}

function forgotBody({ submitted } = {}) {
  if (submitted) {
    // Same wording whether or not the email matched, so this page alone
    // doesn't reveal which accounts exist. It CANNOT fully hide that,
    // though: with no real email delivery wired in yet (see module header),
    // a real match's link is shown directly right here rather than
    // silently "sent" — so a matched vs. unmatched submission is
    // observably different (a link appears or it doesn't). Acceptable
    // stand-in until real delivery exists; not a claim of full opacity.
    return `
      <p class="success">If that email has an account, a password-reset link has been sent.</p>
      <p class="auth-aux">Link expires in 1 hour. <a href="/login">← Back to sign in</a></p>`;
  }
  return `
    <p class="muted">Enter your email. If an account exists, you'll get a reset link.</p>
    <form class="form auth-form" method="post" action="/forgot">
      <label class="wide">Email<input type="email" name="email" required autofocus autocomplete="username"></label>
      <div class="actions"><button type="submit">Send reset link</button></div>
    </form>
    <p class="auth-aux"><a href="/login">← Back to sign in</a></p>`;
}

function resetPasswordBody({ error, invalid } = {}) {
  if (invalid) {
    return `<p class="error">This reset link is invalid or has expired.</p><p class="auth-aux"><a href="/forgot">Request a new one</a></p>`;
  }
  return `
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form class="form auth-form" method="post">
      <label class="wide">New password<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
      <label class="wide">Confirm password<input type="password" name="password2" required minlength="8" autocomplete="new-password"></label>
      <div class="actions"><button type="submit">Reset password</button></div>
    </form>`;
}

function signupBody({ error, body } = {}) {
  const b = body || {};
  return `
    <form class="form auth-form" method="post" action="/signup">
      <p class="muted">Create your church's workspace.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label class="wide">Church name<input name="churchName" required autofocus value="${esc(b.churchName || '')}"></label>
      <label class="wide">Your name<input name="name" required value="${esc(b.name || '')}"></label>
      <label class="wide">Email<input type="email" name="email" required autocomplete="username" value="${esc(b.email || '')}"></label>
      <label class="wide">Password<input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
      <div class="actions"><button type="submit">Create church</button></div>
      <p class="auth-aux">Already have an account? <a href="/login">Sign in</a></p>
    </form>`;
}

function renderLoginForm(req, res, opts) {
  return res.status(401).send(authPage('Sign in', loginBody(opts)));
}

function renderSignupForm(req, res, opts) {
  return res.status(400).send(authPage('Create your church', signupBody(opts)));
}

function register(app) {
  app.get('/login', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.send(authPage('Sign in', loginBody()));
  });

  app.get('/signup', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.send(authPage('Create your church', signupBody()));
  });

  app.get('/forgot', (req, res) => {
    if (res.locals.user) return res.redirect('/');
    res.send(authPage('Reset your password', forgotBody()));
  });

  app.post('/forgot', forgotRateLimit, asyncHandler(async (req, res) => {
    if (res.locals.user) return res.redirect('/');
    const email = (req.body.email || '').trim();
    const result = email ? await createPasswordResetToken(email) : null;
    if (result) {
      const link = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/reset-password/${result.token}`;
      await sendEmailEach(tenantDb(result.user.churchId), [{ addr: result.user.email }],
        'Reset your Church Manager password',
        `Use this secure link within one hour to reset your password:\n\n${link}\n\nIf you did not request this, ignore this email.`,
        { churchName: 'Church Manager', withFooter: false });
    }
    res.send(authPage('Reset your password', forgotBody({ submitted: true })));
  }));

  app.get('/verify-email/:token', asyncHandler(async (req, res) => {
    const valid = await previewEmailVerificationToken(req.params.token);
    if (!valid) return res.status(400).send(authPage('Verify email', '<p class="error">This verification link is invalid or expired.</p>'));
    return res.send(authPage('Verify email', `
      <p>Click below to activate your account. This confirms it was really you who opened this link.</p>
      <form class="form auth-form" method="post" action="/verify-email/${esc(req.params.token)}">
        <div class="actions"><button type="submit">Verify my email</button></div>
      </form>`));
  }));

  app.post('/verify-email/:token', asyncHandler(async (req, res) => {
    const user = await verifyEmailToken(req.params.token);
    if (!user) return res.status(400).send(authPage('Verify email', '<p class="error">This verification link is invalid or expired.</p>'));
    return res.send(authPage('Email verified', '<p class="success">Your email is verified.</p><p><a href="/login">Sign in</a></p>'));
  }));

  app.post('/resend-verification', resendVerificationRateLimit, asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = await require('./tenant').db.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt) {
      const result = await createEmailVerificationToken(user.id);
      const link = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/verify-email/${result.token}`;
      await sendEmailEach(tenantDb(user.churchId), [{ addr: user.email }], 'Verify your Church Manager email',
        `Verify your email within 24 hours:\n\n${link}`, { churchName: 'Church Manager', withFooter: false });
    }
    return res.send(authPage('Verify email', '<p class="success">If verification is needed, a new link has been sent.</p>'));
  }));

  app.get('/reset-password/:token', asyncHandler(async (req, res) => {
    if (res.locals.user) return res.redirect('/');
    const valid = await findValidResetToken(req.params.token);
    res.send(authPage('Set a new password', resetPasswordBody({ invalid: !valid })));
  }));

  app.post('/reset-password/:token', asyncHandler(async (req, res) => {
    if (res.locals.user) return res.redirect('/');
    const { password, password2 } = req.body || {};
    if (!password || password.length < 8 || password !== password2) {
      return res.status(400).send(authPage('Set a new password', resetPasswordBody({ error: 'Passwords must match and be at least 8 characters.' })));
    }
    try {
      await resetPasswordWithToken(req.params.token, password);
    } catch (e) {
      return res.status(400).send(authPage('Set a new password', resetPasswordBody({ invalid: true })));
    }
    res.redirect('/login');
  }));
}

module.exports = { register, renderLoginForm, renderSignupForm };
