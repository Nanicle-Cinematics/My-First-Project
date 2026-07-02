'use strict';
// Phase 8a: one-shot flash messages, ported verbatim from server.js:936-945.
// Pure req.session mutation, zero SQLite coupling.

function flash(req, msg, type = 'error') {
  req.session.flash = { msg, type };
}

function flashRead(req, res, next) {
  if (req.session.flash) {
    res.locals.flash = req.session.flash.msg;
    res.locals.flashType = req.session.flash.type;
    delete req.session.flash;
  }
  next();
}

module.exports = { flash, flashRead };
