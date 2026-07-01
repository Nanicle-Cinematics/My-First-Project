'use strict';
// Phase 2, module 3 of 5: Postgres/Prisma port of routes/inventory.js.
// Same coexistence approach as the other routes-pg/*.js modules.

const asyncHandler = require('../lib/async-handler');

const RECOMMENDED_CATEGORIES = [
  'Audio-Visual / Media',
  'Instruments',
  'Sound Equipment',
  'Office Supplies',
  'Children Ministry',
  'Kitchen & Catering',
  'Cleaning & Sanitation',
  'Furniture',
  'Electrical',
  'Maintenance Tools',
  'Security',
  'Outreach & Evangelism',
  'Transport',
  'Worship Materials',
];

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function parseItemBody(b) {
  return {
    name: (b.name || '').trim(),
    quantity: Math.max(0, Number(b.quantity) || 0),
    category: (b.category || '').trim() || null,
    acquiredOn: b.acquiredOn ? new Date(b.acquiredOn) : null,
    notes: (b.notes || '').trim() || null,
  };
}

function register(app) {
  app.get('/api/inventory/categories', requireAuth, asyncHandler(async (req, res) => {
    const saved = await res.locals.db.inventoryCategory.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
    const merged = [...new Set([...RECOMMENDED_CATEGORIES, ...saved.map((c) => c.name)])].sort((a, b) => a.localeCompare(b));
    res.json(merged);
  }));

  app.post('/api/inventory/categories', requireAdmin, asyncHandler(async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const category = await res.locals.db.inventoryCategory.upsert({
      where: { churchId_name: { churchId: res.locals.churchId, name } },
      update: { deletedAt: null },
      create: { name },
    });
    res.status(201).json(category);
  }));

  app.get('/api/inventory', requireAuth, asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    const items = await res.locals.db.inventoryItem.findMany({
      where: {
        deletedAt: null,
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  }));

  app.get('/api/inventory/:id', requireAuth, asyncHandler(async (req, res) => {
    const item = await res.locals.db.inventoryItem.findFirst({
      where: { id: Number(req.params.id), deletedAt: null },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  }));

  app.post('/api/inventory', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseItemBody(req.body || {});
    if (!v.name) return res.status(400).json({ error: 'name is required' });
    const item = await res.locals.db.inventoryItem.create({ data: v });
    res.status(201).json(item);
  }));

  app.put('/api/inventory/:id', requireAdmin, asyncHandler(async (req, res) => {
    const v = parseItemBody(req.body || {});
    if (!v.name) return res.status(400).json({ error: 'name is required' });
    try {
      const item = await res.locals.db.inventoryItem.update({
        where: { id: Number(req.params.id) },
        data: { ...v, updatedAt: new Date() },
      });
      res.json(item);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Item not found' });
      throw e;
    }
  }));

  app.delete('/api/inventory/:id', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.inventoryItem.update({
        where: { id: Number(req.params.id) },
        data: { deletedAt: new Date() },
      });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Item not found' });
      throw e;
    }
  }));
}

module.exports = { register };
