'use strict';
// Audit-trail coverage for the modules that previously wrote nothing:
// bible-classes, organizations, settings, and the account-security half of
// users. Two distinct trails are asserted here and they are NOT
// interchangeable — ActivityLog is the tenant-facing feed (no IP/UA),
// SecurityAuditLog is the security trail (IP + user-agent, and what
// settings.js's MFA routes and platform.js already write to).
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createTenantApp } = require('../lib/tenant-http');
const { db } = require('../lib/tenant');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const createdChurchIds = [];

let server, base;
test.before(async () => {
  const app = createTenantApp({ pool });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  if (createdChurchIds.length) {
    const where = { churchId: { in: createdChurchIds } };
    await db.activityLog.deleteMany({ where });
    await db.securityAuditLog.deleteMany({ where });
    await db.organizationMembership.deleteMany({ where });
    await db.organization.deleteMany({ where });
    await db.ministry.deleteMany({ where });
    await db.member.deleteMany({ where });
    await db.account.deleteMany({ where });
    await db.user.deleteMany({ where });
    await db.specialCategory.deleteMany({ where });
    await db.serviceType.deleteMany({ where });
    await db.expenseCategory.deleteMany({ where });
    await db.church.deleteMany({ where: { id: { in: createdChurchIds } } });
  }
  await db.$disconnect();
  await pool.end();
});

function htmlClient() {
  let cookie;
  const remember = (res) => {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) if (c.startsWith('connect.sid=')) cookie = c.split(';')[0];
  };
  return {
    async postJson(p, jsonBody) {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(jsonBody),
      });
      remember(res);
      return { status: res.status, body: await res.json() };
    },
    async getHtml(p) {
      const res = await fetch(base + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      remember(res);
      return { status: res.status, location: res.headers.get('location'), text: res.status < 300 ? await res.text() : '' };
    },
    async postForm(p, form) {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams(form).toString(),
        redirect: 'manual',
      });
      remember(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

function uniqueEmail(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : null;
}

async function signedInClient(tag) {
  const client = htmlClient();
  const signup = await client.postJson('/signup', {
    churchName: `${tag} Church`, name: 'Admin Person', email: uniqueEmail(tag), password: 'password123',
  });
  assert.strictEqual(signup.status, 201);
  const churchId = signup.body.church.id;
  createdChurchIds.push(churchId);
  return { client, churchId };
}

const kinds = async (churchId) =>
  (await db.activityLog.findMany({ where: { churchId }, orderBy: { id: 'asc' } })).map((r) => r.kind);

// Every entry must carry the acting user — an audit row with a null actor is
// worse than useless, and logActivity() silently accepts undefined.
async function assertActorsRecorded(churchId) {
  const rows = await db.activityLog.findMany({ where: { churchId } });
  for (const row of rows) {
    assert.ok(row.userId, `activity "${row.kind}" recorded no acting user`);
  }
}

test('bible-classes: create and update each write an activity entry', async () => {
  const { client, churchId } = await signedInClient('act-bc');
  const page = await client.getHtml('/bible-classes');
  const csrf = extractCsrf(page.text);

  await client.postForm('/bible-classes', { name: 'Young Adults', meetsOn: 'Sunday 8am', _csrf: csrf });
  const listed = await client.getHtml('/bible-classes');
  const idMatch = listed.text.match(/\/bible-classes\/(\d+)"/);
  assert.ok(idMatch, 'expected the new class to expose an edit target');
  await client.postForm(`/bible-classes/${idMatch[1]}`, { _csrf: extractCsrf(listed.text) });

  const seen = await kinds(churchId);
  assert.ok(seen.includes('bible_class_added'), `expected bible_class_added, got ${seen.join(', ')}`);
  assert.ok(seen.includes('bible_class_updated'), `expected bible_class_updated, got ${seen.join(', ')}`);

  const added = await db.activityLog.findFirst({ where: { churchId, kind: 'bible_class_added' } });
  assert.match(added.description, /Young Adults/, 'the entry should name the class, not just its id');
  await assertActorsRecorded(churchId);
});

test('bible-classes: a rejected duplicate does not write a phantom entry', async () => {
  const { client, churchId } = await signedInClient('act-bc-dup');
  const page = await client.getHtml('/bible-classes');
  const csrf = extractCsrf(page.text);

  await client.postForm('/bible-classes', { name: 'Same Name', _csrf: csrf });
  const second = await client.getHtml('/bible-classes');
  await client.postForm('/bible-classes', { name: 'Same Name', _csrf: extractCsrf(second.text) });

  const added = await db.activityLog.findMany({ where: { churchId, kind: 'bible_class_added' } });
  assert.strictEqual(added.length, 1, 'the swallowed P2002 must not produce a second activity entry');
});

test('organizations: the full lifecycle writes one entry per real change', async () => {
  const { client, churchId } = await signedInClient('act-org');
  const member = await db.member.create({
    data: { churchId, firstName: 'Ama', lastName: 'Mensah', externalId: 'MBR-900' },
  });

  const newPage = await client.getHtml('/organizations/new');
  await client.postForm('/organizations', { name: 'Choir', _csrf: extractCsrf(newPage.text) });
  const org = await db.organization.findFirst({ where: { churchId, name: 'Choir' } });
  assert.ok(org, 'expected the organization to exist');

  const detail = await client.getHtml(`/organizations/${org.id}`);
  const csrf = extractCsrf(detail.text);
  await client.postForm(`/organizations/${org.id}/add`, { memberId: String(member.id), _csrf: csrf });
  await client.postForm(`/organizations/${org.id}/leader`, { leaderId: String(member.id), _csrf: csrf });
  await client.postForm(`/organizations/${org.id}/remove`, { memberId: String(member.id), _csrf: csrf });
  await client.postForm(`/organizations/${org.id}/archive`, { _csrf: csrf });

  const seen = await kinds(churchId);
  for (const kind of ['organization_added', 'organization_member_added', 'organization_leader_changed',
    'organization_member_removed', 'organization_archived']) {
    assert.ok(seen.includes(kind), `expected ${kind}, got ${seen.join(', ')}`);
  }
  // The remove entry resolves names after the delete — prove it did not fall
  // back to the "#id" placeholder branch.
  const removed = await db.activityLog.findFirst({ where: { churchId, kind: 'organization_member_removed' } });
  assert.match(removed.description, /Ama Mensah/);
  assert.match(removed.description, /Choir/);
  await assertActorsRecorded(churchId);
});

test('settings: renaming the church and clearing the logo are both recorded', async () => {
  const { client, churchId } = await signedInClient('act-settings');
  const page = await client.getHtml('/settings');
  const csrf = extractCsrf(page.text);

  await client.postForm('/settings', { name: 'Renamed Assembly', _csrf: csrf });
  await client.postForm('/settings/logo/delete', { _csrf: csrf });

  const seen = await kinds(churchId);
  assert.ok(seen.includes('settings_updated'), `expected settings_updated, got ${seen.join(', ')}`);
  assert.ok(seen.includes('settings_logo_removed'), `expected settings_logo_removed, got ${seen.join(', ')}`);
  const renamed = await db.activityLog.findFirst({ where: { churchId, kind: 'settings_updated' } });
  assert.match(renamed.description, /Renamed Assembly/);
  await assertActorsRecorded(churchId);
});

test('users: account-security actions write to BOTH the activity feed and the security trail', async () => {
  const { client, churchId } = await signedInClient('act-users');
  const listPage = await client.getHtml('/users');
  const teammateEmail = uniqueEmail('act-teammate');
  await client.postForm('/users', {
    username: 'teammate', displayName: 'Team Mate', email: teammateEmail,
    password: 'teampass123', role: 'EDITOR', financeRole: 'CASHIER', _csrf: extractCsrf(listPage.text),
  });

  const afterCreate = await client.getHtml('/users');
  const idMatch = afterCreate.text.match(/\/users\/(\d+)\/role/);
  assert.ok(idMatch, 'expected a role-change form for the new teammate');
  const teammateId = idMatch[1];
  const csrf = extractCsrf(afterCreate.text);

  await client.postForm(`/users/${teammateId}/role`, { role: 'VIEWER', financeRole: 'NONE', _csrf: csrf });
  await client.postForm(`/users/${teammateId}/reset`, { password: 'newpassword123', _csrf: csrf });
  await client.postForm(`/users/${teammateId}/disable-2fa`, { _csrf: csrf });
  await client.postForm(`/users/${teammateId}/delete`, { _csrf: csrf });

  const seen = await kinds(churchId);
  for (const kind of ['user_created', 'user_role_changed', 'user_password_reset', 'user_2fa_disabled', 'user_deleted']) {
    assert.ok(seen.includes(kind), `expected ${kind} in the activity feed, got ${seen.join(', ')}`);
  }

  const events = (await db.securityAuditLog.findMany({ where: { churchId } })).map((r) => r.event);
  for (const event of ['user.role_changed', 'user.password_reset_by_admin', 'user.mfa_disabled_by_admin', 'user.deleted']) {
    assert.ok(events.includes(event), `expected ${event} in the security trail, got ${events.join(', ')}`);
  }
  // The security trail's whole reason for existing over ActivityLog is the
  // request context — assert it actually landed.
  const roleEvent = await db.securityAuditLog.findFirst({ where: { churchId, event: 'user.role_changed' } });
  assert.ok(roleEvent.ip, 'security events must capture the request IP');
  assert.ok(roleEvent.userAgent, 'security events must capture the user agent');
  assert.ok(roleEvent.actorId, 'security events must capture the acting admin');
  assert.match(roleEvent.subject, new RegExp(teammateEmail.replace(/[.+]/g, '\\$&')));
  await assertActorsRecorded(churchId);
});

test('activity entries never leak across tenants', async () => {
  const a = await signedInClient('act-iso-a');
  const b = await signedInClient('act-iso-b');

  const aPage = await a.client.getHtml('/bible-classes');
  await a.client.postForm('/bible-classes', { name: 'Church A Only', _csrf: extractCsrf(aPage.text) });

  const bRows = await db.activityLog.findMany({ where: { churchId: b.churchId } });
  assert.ok(!bRows.some((r) => /Church A Only/.test(r.description)),
    "church B's feed must not contain church A's activity");

  const aRows = await db.activityLog.findMany({ where: { churchId: a.churchId } });
  assert.ok(aRows.some((r) => /Church A Only/.test(r.description)));
});
