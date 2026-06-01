'use strict';
// Inventory routes. Registered via register(app, ctx) so server.js injects the
// shared dependencies instead of these reaching for module globals.
module.exports.register = function register(app, ctx) {
  const { db, esc, pageHero, statsRow, filterCard, requireAdmin, logActivity } = ctx;
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

  app.get('/inventory', (req, res) => {
    const q = (req.query.q || '').trim();
    const savedCategories = db.prepare(`
      SELECT category_id, name
      FROM inventory_categories
      WHERE deleted_at IS NULL
      ORDER BY name`).all();
    const categories = [...new Set([
      ...RECOMMENDED_CATEGORIES,
      ...savedCategories.map((c) => c.name),
    ])].sort((a, b) => a.localeCompare(b));
    const items = db.prepare(`
      SELECT item_id, name, quantity, category, notes
      FROM inventory_items
      WHERE deleted_at IS NULL ${q ? 'AND name LIKE @q' : ''}
      ORDER BY COALESCE(category, 'zzz'), name`).all(q ? { q: `%${q}%` } : {});

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

    const newForm = res.locals.isAdmin
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Add an item</strong></summary>
           <form class="form" method="post" action="/inventory" style="margin-top:0.75rem">
             <label class="wide">Name<input name="name" required></label>
             <label>Quantity<input type="number" name="quantity" min="0" value="0" required></label>
             <label>Category
               <select name="category">
                 <option value="">Uncategorized</option>
                 ${categories.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join('')}
               </select>
             </label>
             <label class="wide-cell">Notes<textarea name="notes" rows="2"></textarea></label>
             <div class="actions"><button type="submit">Add item</button></div>
           </form>
         </details>`
      : '';
    const newCategoryForm = res.locals.isAdmin
      ? `<details class="form-toggle" style="margin-bottom:1rem">
           <summary><strong>+ Create inventory category</strong></summary>
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
              <td>${it.notes ? esc(it.notes) : '—'}</td>
              ${res.locals.isAdmin ? `<td style="white-space:nowrap">
                <a href="/inventory/${it.item_id}/edit" class="link">Edit</a>
                <form method="post" action="/inventory/${it.item_id}/delete" class="inline"
                      onsubmit="return confirm('Archive this item? It will be hidden but not permanently deleted.')">
                  <button type="submit" class="link">Archive</button>
                </form>
              </td>` : ''}
            </tr>`).join('');
          return `<section class="card" style="margin-bottom:1rem">
            <div class="card-head"><h2>${esc(c)}</h2>
              <span class="meta">${grouped[c].length} item${grouped[c].length === 1 ? '' : 's'}</span></div>
            <table>
              <thead><tr><th>Name</th><th>Qty</th><th>Notes</th>${res.locals.isAdmin ? '<th></th>' : ''}</tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </section>`;
        }).join('')
      : '<div class="empty-state"><div class="empty-ico">📦</div><p>No inventory items match your search.</p></div>';

    const totals = db.prepare(`SELECT COUNT(*) items, COALESCE(SUM(quantity),0) qty,
      COUNT(DISTINCT COALESCE(NULLIF(TRIM(category),''),'Uncategorized')) cats
      FROM inventory_items WHERE deleted_at IS NULL`).get();
    const hero = pageHero('Inventory', 'Register of physical items the church owns.');
    const stats = statsRow([
      { cls: 'gold', icon: '📦', value: Number(totals.items).toLocaleString(), label: 'Items' },
      { cls: 'green', icon: '🗂', value: Number(totals.cats).toLocaleString(), label: 'Categories' },
      { cls: 'blue', icon: '#', value: Number(totals.qty).toLocaleString(), label: 'Total Quantity' },
    ]);
    const filters = filterCard({ q, placeholder: 'Search items by name…' });

    res.page({
      title: 'Inventory',
      active: '/inventory', noHeader: true,
      body: `${hero}${stats}${filters}${newCategoryForm}${newForm}<div data-results>${sections}</div>`,
    });
  });

  app.post('/inventory/categories', requireAdmin, (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/inventory');
    db.prepare(`
      INSERT INTO inventory_categories (name)
      VALUES (?)
      ON CONFLICT(name) DO UPDATE SET deleted_at=NULL`).run(name);
    logActivity('inventory_category_added',
      `Created inventory category: ${name}`,
      '/inventory', res.locals.user.user_id);
    res.redirect('/inventory');
  });

  app.post('/inventory', requireAdmin, (req, res) => {
    const b = req.body;
    const name = (b.name || '').trim();
    if (!name) return res.redirect('/inventory');
    const qty = Math.max(0, Number(b.quantity) || 0);
    const category = (b.category || '').trim() || null;
    const notes = (b.notes || '').trim() || null;
    db.prepare(`
      INSERT INTO inventory_items (name, quantity, category, notes)
      VALUES (?, ?, ?, ?)`).run(name, qty, category, notes);
    logActivity('inventory_added',
      `Added inventory item: ${name} (qty ${qty})`,
      '/inventory', res.locals.user.user_id);
    res.redirect('/inventory');
  });

  app.get('/inventory/:id/edit', requireAdmin, (req, res) => {
    const savedCategories = db.prepare(`
      SELECT name
      FROM inventory_categories
      WHERE deleted_at IS NULL
      ORDER BY name`).all();
    const categories = [...new Set([
      ...RECOMMENDED_CATEGORIES,
      ...savedCategories.map((c) => c.name),
    ])].sort((a, b) => a.localeCompare(b));
    const it = db.prepare(
      `SELECT * FROM inventory_items WHERE item_id=? AND deleted_at IS NULL`
    ).get(Number(req.params.id));
    if (!it) return res.status(404).send('Item not found');
    res.page({
      title: 'Edit Item', active: '/inventory',
      body: `
        <form class="form" method="post" action="/inventory/${it.item_id}">
          <label class="wide">Name<input name="name" required value="${esc(it.name)}"></label>
          <label>Quantity<input type="number" name="quantity" min="0" required value="${esc(String(it.quantity))}"></label>
          <label>Category
            <select name="category">
              <option value="">Uncategorized</option>
              ${categories.map((name) => `<option value="${esc(name)}"${(it.category || '') === name ? ' selected' : ''}>${esc(name)}</option>`).join('')}
            </select>
          </label>
          <label class="wide-cell">Notes<textarea name="notes" rows="3">${esc(it.notes || '')}</textarea></label>
          <div class="actions">
            <button type="submit">Save changes</button>
            <a href="/inventory" class="link">Cancel</a>
          </div>
        </form>`,
    });
  });

  app.post('/inventory/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const b = req.body;
    const name = (b.name || '').trim();
    if (!name) return res.redirect(`/inventory/${id}/edit`);
    const qty = Math.max(0, Number(b.quantity) || 0);
    const category = (b.category || '').trim() || null;
    const notes = (b.notes || '').trim() || null;
    db.prepare(`
      UPDATE inventory_items
         SET name=?, quantity=?, category=?, notes=?, updated_at=CURRENT_TIMESTAMP
       WHERE item_id=? AND deleted_at IS NULL`)
      .run(name, qty, category, notes, id);
    logActivity('inventory_updated',
      `Updated inventory item: ${name} (qty ${qty})`,
      '/inventory', res.locals.user.user_id);
    res.redirect('/inventory');
  });

  app.post('/inventory/:id/delete', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const it = db.prepare(`SELECT name FROM inventory_items WHERE item_id=?`).get(id);
    db.prepare(`UPDATE inventory_items SET deleted_at=CURRENT_TIMESTAMP WHERE item_id=?`).run(id);
    if (it) {
      logActivity('inventory_archived',
        `Archived inventory item: ${it.name}`,
        '/inventory', res.locals.user.user_id);
    }
    res.redirect('/inventory');
  });
};
