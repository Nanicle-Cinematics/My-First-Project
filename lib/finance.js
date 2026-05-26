'use strict';
// Finance aggregations, parameterized by db + year so they can be unit-tested
// against an in-memory database with edge-case data.

function givingYears() {
  const now = new Date().getFullYear();
  const years = [];
  for (let y = now; y >= now - 6; y--) years.push(y);
  return years;
}
function safeYear(v) {
  const y = String(v || '').replace(/[^0-9]/g, '');
  return /^\d{4}$/.test(y) ? y : String(new Date().getFullYear());
}

// Year-to-date totals across every income/expense source.
function financeYtd(db, year) {
  const y = String(year);
  const t = (sql, params) => db.prepare(sql).get(params).t;
  const services = t(`SELECT COALESCE(SUM(total_amount),0) t FROM services
                        WHERE deleted_at IS NULL AND substr(service_date,1,4)=@y`, { y });
  const harvests = t(`SELECT COALESCE(SUM(total_collected),0) t FROM harvests
                        WHERE deleted_at IS NULL AND harvest_year=@hy`, { hy: Number(y) });
  const special = t(`SELECT COALESCE(SUM(amount),0) t FROM special_offerings
                       WHERE deleted_at IS NULL AND substr(offering_date,1,4)=@y`, { y });
  const tithes = t(`SELECT COALESCE(SUM(amount),0) t FROM tithes
                      WHERE deleted_at IS NULL AND substr(tithe_date,1,4)=@y`, { y });
  const expenses = t(`SELECT COALESCE(SUM(amount),0) t FROM expenses
                        WHERE substr(spent_on,1,4)=@y`, { y });
  const offerings = services + special + tithes;
  const net = offerings + harvests - expenses;
  return { services, harvests, special, tithes, expenses, offerings, net };
}

// Every gift attributable to one member in a year, merged + sorted, with subtotals.
function memberGivingForYear(db, memberId, year) {
  const y = String(year);
  const lines = [];
  for (const r of db.prepare(`SELECT tithe_date dt, amount, COALESCE(method,'') method, reference
      FROM tithes WHERE member_id=? AND deleted_at IS NULL AND substr(tithe_date,1,4)=?`).all(memberId, y)) {
    lines.push({ dt: r.dt, group: 'Tithes', category: 'Tithe', detail: [r.method, r.reference].filter(Boolean).join(' · '), amount: r.amount });
  }
  for (const r of db.prepare(`SELECT sp.offering_date dt, sp.amount, sc.category_name, COALESCE(sp.purpose,'') purpose, sp.receipt_number
      FROM special_offerings sp JOIN special_categories sc USING(special_cat_id)
      WHERE sp.donor_id=? AND sp.deleted_at IS NULL AND substr(sp.offering_date,1,4)=?`).all(memberId, y)) {
    lines.push({ dt: r.dt, group: 'Special Offerings', category: r.category_name, detail: [r.purpose, r.receipt_number].filter(Boolean).join(' · '), amount: r.amount });
  }
  for (const r of db.prepare(`SELECT c.contributed_on dt, c.amount, f.name fund, COALESCE(c.method,'') method, c.reference
      FROM contributions c JOIN funds f USING(fund_id)
      WHERE c.member_id=? AND substr(c.contributed_on,1,4)=?`).all(memberId, y)) {
    lines.push({ dt: r.dt, group: 'Contributions', category: r.fund, detail: [r.method, r.reference].filter(Boolean).join(' · '), amount: r.amount });
  }
  for (const r of db.prepare(`SELECT pp.paid_on dt, pp.amount, h.harvest_name, pp.receipt_number
      FROM pledge_payments pp JOIN pledges pl USING(pledge_id) JOIN harvests h USING(harvest_id)
      WHERE pl.member_id=? AND substr(pp.paid_on,1,4)=?`).all(memberId, y)) {
    lines.push({ dt: r.dt, group: 'Pledge Redemptions', category: `Pledge — ${r.harvest_name}`, detail: r.receipt_number || '', amount: r.amount });
  }
  lines.sort((a, b) => String(a.dt).localeCompare(String(b.dt)));
  const byGroup = {};
  for (const l of lines) byGroup[l.group] = (byGroup[l.group] || 0) + l.amount;
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, byGroup, total };
}

// Per-member giving totals for a year (statements index). Excludes anonymous,
// soft-deleted gifts, and deleted members; only members with positive totals.
function givingByMember(db, year) {
  return db.prepare(`
    SELECT g.member_id, m.external_id, m.first_name || ' ' || m.last_name AS name,
           COUNT(*) gifts, SUM(g.amount) total
    FROM (
      SELECT member_id, amount FROM tithes
        WHERE deleted_at IS NULL AND member_id IS NOT NULL AND substr(tithe_date,1,4)=@y
      UNION ALL
      SELECT donor_id AS member_id, amount FROM special_offerings
        WHERE deleted_at IS NULL AND donor_id IS NOT NULL AND substr(offering_date,1,4)=@y
      UNION ALL
      SELECT member_id, amount FROM contributions
        WHERE member_id IS NOT NULL AND substr(contributed_on,1,4)=@y
      UNION ALL
      SELECT pl.member_id, pp.amount FROM pledge_payments pp JOIN pledges pl USING(pledge_id)
        WHERE substr(pp.paid_on,1,4)=@y
    ) g JOIN members m ON m.member_id = g.member_id AND m.deleted_at IS NULL
    GROUP BY g.member_id HAVING total > 0
    ORDER BY total DESC`).all({ y: String(year) });
}

module.exports = { givingYears, safeYear, financeYtd, memberGivingForYear, givingByMember };
