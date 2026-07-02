'use strict';
// Phase 8b: HTML port of routes/inventory.js onto the Postgres stack.
// Registered ALONGSIDE routes-pg/inventory.js (JSON at /api/inventory, this
// is the bare-path HTML surface) — see the Phase 8 plan's recipe.
// Role model: admin-only writes, matching routes-pg/inventory.js.

const asyncHandler = require('../lib/async-handler');
const { esc } = require('../lib/format');
const { pageHero, statsRow, filterCard } = require('../lib/views');
const { logActivity } = require('../lib/tenant-activity');

const RECOMMENDED_CATEGORIES = [
  'Audio-Visual / Media', 'Instruments', 'Sound Equipment', 'Office Supplies',
  'Children Ministry', 'Kitchen & Catering', 'Cleaning & Sanitation', 'Furniture',
  'Electrical', 'Maintenance Tools', 'Security', 'Outreach & Evangelism',
  'Transport', 'Worship Materials',
];

function requireAdmin(req, res, next) {
  if (res.locals.user && res.locals.user.role === 'ADMIN') return next();
  return res.status(403).send('Forbidden');
}

// Prisma DateTime -> the plain YYYY-MM-DD string lib/format.js/<input type=date> expect.
function iso(d) {
  if (!d) return '';
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

async function mergedCategories(db) {
  const saved = await db.inventoryCategory.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  return [...new Set([...RECOMMENDED_CATEGORIES, ...saved.map((c) => c.name)])].sort((a, b) => a.localeCompare(b));
}

function register(app) {
  app.get('/inventory', asyncHandler(async (req, res) => {
    if (!res.locals.user) return res.redirect('/login');
    const db = res.locals.db;
    const isAdmin = res.locals.user.role === 'ADMIN';
    const q = (req.query.q || '').trim();

    const [categories, items] = await Promise.all([
      mergedCategories(db),
      db.inventoryItem.findMany({
        where: { deletedAt: null, ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const grouped = {};
    for (const it of items) {
      const k = it.category && it.category.trim() ? it.category : 'Uncategorized';
      (grouped[k] = grouped[k] || []).push(it);
    }
    const cats = Object.keys(grouped).sort((a, b) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      return a.localeCompare(b);
    });

    const newForm = isAdmin
      ? `<details class="form-toggle" id="add-item" style="margin-bottom:1rem">
           <summary><strong>＋ Add an item</strong></summary>
           <form class="form" method="post" action="/inventory" style="margin-top:0.75rem">
             <label class="wide">Name<input name="name" required></label>
             <label>Quantity<input type="number" name="quantity" min="0" value="0" required></label>
             <label>Category
               <select name="category">
                 <option value="">Uncategorized</option>
                 ${categories.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}
               </select>
             </label>
             <label>Date of purchase/Donated<input type="date" name="acquiredOn"></label>
             <label class="wide-cell">Notes<textarea name="notes" rows="2"></textarea></label>
             <div class="actions"><button type="submit">Add item</button></div>
           </form>
         </details>`
      : '';
    const newCategoryForm = isAdmin
      ? `<details class="form-toggle" id="add-category" style="margin-bottom:1rem">
           <summary><strong>＋ Create inventory category</strong></summary>
           <form class="form" method="post" action="/inventory/categories" style="margin-top:0.75rem">
             <label class="wide">Category name<input name="name" placeholder="e.g. Instruments" required></label>
             <div class="actions"><button type="submit">Create category</button></div>
           </form>
         </details>`
      : '';

    const sections = items.length
      ? cats.map((c) => {
          const rows = grouped[c].map((it) => `
            <tr>
              <td>${esc(it.name)}</td>
              <td>${esc(String(it.quantity))}</td>
              <td>${it.acquiredOn ? esc(iso(it.acquiredOn)) : '—'}</td>
              <td>${it.notes ? esc(it.notes) : '—'}</td>
              ${isAdmin ? `<td style="white-space:nowrap">
                <a href="/inventory/${it.id}/edit" class="link">Edit</a>
                <form method="post" action="/inventory/${it.id}/delete" class="inline"
                      onsubmit="return confirm('Archive this item? It will be hidden but not permanently deleted.')">
                  <button type="submit" class="link">Archive</button>
                </form>
              </td>` : ''}
            </tr>`).join('');
          return `<section class="card" style="margin-bottom:1rem">
            <div class="card-head"><h2>${esc(c)}</h2>
              <span class="meta">${grouped[c].length} item${grouped[c].length === 1 ? '' : 's'}</span></div>
            <table>
              <thead><tr><th>Name</th><th>Qty</th><th>Purchase / Donation Date</th><th>Notes</th>${isAdmin ? '<th></th>' : ''}</tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </section>`;
        }).join('')
      : `<div class="empty-state">
          <div class="empty-ico" aria-hidden="true">📦</div>
          <h3>${q ? `No items match "${esc(q)}"` : 'No inventory items yet'}</h3>
          <p>${q ? 'Try a different search term, or add a new item below.' : 'Track what your church owns. Use the form below to add your first item.'}</p>
          ${q ? '<div style="margin-top:0.6rem"><a class="link" href="/inventory">Clear search →</a></div>' : ''}
        </div>`;

    const totals = {
      items: items.length,
      qty: items.reduce((s, it) => s + it.quantity, 0),
      cats: cats.length,
    };
    const hero = pageHero('Inventory', 'Register of physical items the church owns.');
    const stats = statsRow([
      { cls: 'gold', icon: '📦', value: totals.items.toLocaleString(), label: 'Items' },
      { cls: 'green', icon: '🗂', value: totals.cats.toLocaleString(), label: 'Categories' },
      { cls: 'blue', icon: '#', value: totals.qty.toLocaleString(), label: 'Total Quantity' },
    ], isAdmin
      ? `<a class="btn primary" href="#add-item">＋ Add Item</a>
         <a class="btn ghost" href="#add-category">＋ Category</a>`
      : '');
    const filters = filterCard({ q, placeholder: 'Search items by name…' });

    res.page({
      title: 'Inventory',
      active: '/inventory', noHeader: true,
      body: `${hero}${stats}${filters}${newCategoryForm}${newForm}<div data-results>${sections}</div>`,
    });
  }));

  app.post('/inventory/categories', requireAdmin, asyncHandler(async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/inventory');
    await res.locals.db.inventoryCategory.upsert({
      where: { churchId_name: { churchId: res.locals.churchId, name } },
      update: { deletedAt: null },
      create: { name },
    });
    await logActivity(res.locals.db, 'inventory_category_added', `Created inventory category: ${name}`, '/inventory', res.locals.user.id);
    res.redirect('/inventory');
  }));

  app.post('/inventory', requireAdmin, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.redirect('/inventory');
    const quantity = Math.max(0, Number(b.quantity) || 0);
    const item = await res.locals.db.inventoryItem.create({
      data: {
        name, quantity,
        category: (b.category || '').trim() || null,
        acquiredOn: b.acquiredOn ? new Date(b.acquiredOn) : null,
        notes: (b.notes || '').trim() || null,
      },
    });
    await logActivity(res.locals.db, 'inventory_added', `Added inventory item: ${item.name} (qty ${quantity})`, '/inventory', res.locals.user.id);
    res.redirect('/inventory');
  }));

  app.get('/inventory/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
    const db = res.locals.db;
    const [categories, it] = await Promise.all([
      mergedCategories(db),
      db.inventoryItem.findFirst({ where: { id: Number(req.params.id), deletedAt: null } }),
    ]);
    if (!it) return res.status(404).send('Item not found');
    res.page({
      title: 'Edit Item', active: '/inventory', noHeader: true,
      body: `${pageHero('Edit Item', '')}
        <form class="form" method="post" action="/inventory/${it.id}">
          <label class="wide">Name<input name="name" required value="${esc(it.name)}"></label>
          <label>Quantity<input type="number" name="quantity" min="0" required value="${esc(String(it.quantity))}"></label>
          <label>Category
            <select name="category">
              <option value="">Uncategorized</option>
              ${categories.map((name) => `<option value="${esc(name)}"${(it.category || '') === name ? ' selected' : ''}>${esc(name)}</option>`).join('')}
            </select>
          </label>
          <label>Date of purchase/Donated<input type="date" name="acquiredOn" value="${esc(iso(it.acquiredOn))}"></label>
          <label class="wide-cell">Notes<textarea name="notes" rows="3">${esc(it.notes || '')}</textarea></label>
          <div class="actions">
            <button type="submit">Save changes</button>
            <a href="/inventory" class="link">Cancel</a>
          </div>
        </form>`,
    });
  }));

  app.post('/inventory/:id', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.redirect(`/inventory/${id}/edit`);
    const quantity = Math.max(0, Number(b.quantity) || 0);
    try {
      await res.locals.db.inventoryItem.update({
        where: { id },
        data: {
          name, quantity,
          category: (b.category || '').trim() || null,
          acquiredOn: b.acquiredOn ? new Date(b.acquiredOn) : null,
          notes: (b.notes || '').trim() || null,
          updatedAt: new Date(),
        },
      });
      await logActivity(res.locals.db, 'inventory_updated', `Updated inventory item: ${name} (qty ${quantity})`, '/inventory', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/inventory');
  }));

  app.post('/inventory/:id/delete', requireAdmin, asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const it = await res.locals.db.inventoryItem.findFirst({ where: { id } });
    try {
      await res.locals.db.inventoryItem.update({ where: { id }, data: { deletedAt: new Date() } });
      if (it) await logActivity(res.locals.db, 'inventory_archived', `Archived inventory item: ${it.name}`, '/inventory', res.locals.user.id);
    } catch (e) {
      if (e.code !== 'P2025') throw e;
    }
    res.redirect('/inventory');
  }));
}

module.exports = { register };
