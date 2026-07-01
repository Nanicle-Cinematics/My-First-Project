'use strict';
// Phase 2, module 4 of 5: Postgres/Prisma port of routes/organizations.js.
// Same coexistence approach as the other routes-pg/*.js modules. Note: this
// "Organization" is the church-internal-group feature (choirs, brigades,
// fellowships) — unrelated to the multi-tenant "Church" model, which is why
// the tenant model was deliberately NOT named Organization (see schema.prisma
// header comment).

const asyncHandler = require('../lib/async-handler');

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).json({ error: 'forbidden' });
}

function requireAuth(req, res, next) {
  if (!res.locals.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

function register(app) {
  app.get('/api/organizations', requireAuth, asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    const sort = (req.query.sort || '').trim();
    const db = res.locals.db;
    const rows = await db.organization.findMany({
      where: { active: true, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      include: {
        leader: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { memberships: true } },
      },
      orderBy: sort === 'members' ? undefined : { name: 'asc' },
    });
    const shaped = rows.map((o) => ({
      id: o.id, name: o.name, description: o.description, meetsOn: o.meetsOn,
      leader: o.leader, memberCount: o._count.memberships,
    }));
    if (sort === 'members') shaped.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
    res.json(shaped);
  }));

  app.post('/api/organizations', requireAdmin, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const org = await res.locals.db.organization.create({
        data: {
          name: String(b.name).trim(),
          description: b.description || null,
          meetsOn: b.meetsOn || null,
          leaderId: b.leaderId ? Number(b.leaderId) : null,
        },
      });
      res.status(201).json(org);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'An organization with that name already exists' });
      throw e;
    }
  }));

  app.get('/api/organizations/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const org = await res.locals.db.organization.findFirst({
      where: { id, active: true },
      include: { leader: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!org) return res.status(404).json({ error: 'Not found' });
    const members = await res.locals.db.organizationMembership.findMany({
      where: { orgId: id },
      include: { member: { select: { id: true, externalId: true, firstName: true, lastName: true, photoFilename: true } } },
      orderBy: [{ role: 'desc' }, { member: { lastName: 'asc' } }],
    });
    res.json({ ...org, members: members.map((m) => ({ ...m.member, role: m.role })) });
  }));

  app.post('/api/organizations/:id/add', requireAdmin, asyncHandler(async (req, res) => {
    const orgId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });
    const db = res.locals.db;
    // `create` only stamps churchId into the NEW row — it does not verify
    // that orgId/memberId (foreign references) belong to this tenant. Both
    // must be checked explicitly through the scoped client before creating,
    // or a cross-tenant orgId/memberId in the request body would silently
    // link two different tenants' data together.
    const [org, member] = await Promise.all([
      db.organization.findUnique({ where: { id: orgId } }),
      db.member.findUnique({ where: { id: memberId } }),
    ]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    try {
      const membership = await db.organizationMembership.create({
        data: { orgId, memberId, role: req.body.role === 'leader' ? 'leader' : 'member' },
      });
      res.status(201).json(membership);
    } catch (e) {
      if (e.code === 'P2002') return res.status(409).json({ error: 'That member is already in this group' });
      throw e;
    }
  }));

  app.post('/api/organizations/:id/remove', requireAdmin, asyncHandler(async (req, res) => {
    const orgId = Number(req.params.id);
    const memberId = Number(req.body.memberId);
    try {
      await res.locals.db.organizationMembership.delete({ where: { orgId_memberId: { orgId, memberId } } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Membership not found' });
      throw e;
    }
  }));

  app.put('/api/organizations/:id/leader', requireAdmin, asyncHandler(async (req, res) => {
    try {
      const org = await res.locals.db.organization.update({
        where: { id: Number(req.params.id) },
        data: { leaderId: req.body.leaderId ? Number(req.body.leaderId) : null },
      });
      res.json(org);
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));

  app.post('/api/organizations/:id/archive', requireAdmin, asyncHandler(async (req, res) => {
    try {
      await res.locals.db.organization.update({ where: { id: Number(req.params.id) }, data: { active: false } });
      res.status(204).end();
    } catch (e) {
      if (e.code === 'P2025') return res.status(404).json({ error: 'Not found' });
      throw e;
    }
  }));
}

module.exports = { register };
