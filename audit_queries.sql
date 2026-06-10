-- =====================================================================
-- DUNWELL METHODIST CHURCH — DETAILED FINANCIAL AUDIT QUERIES
-- Target: SQLite 3.x  |  Schema: schema.sql (this repo)
-- =====================================================================
-- PURPOSE: In-depth audit queries for every financial dimension:
--          income trails, expense controls, data integrity, user
--          activity, fund balances, and a consolidated exceptions report.
--
-- PARAMETERS: All queries use :param_name bound parameters.
--   :start_date / :end_date  — 'YYYY-MM-DD'
--   :report_year             — '2026'
--   :year_a / :year_b        — '2026' / '2025'  (for YoY queries)
--   :opening_balance         — numeric (prior-period closing figure)
--   :high_threshold          — numeric (e.g. 5000)
--   :expense_threshold       — numeric (e.g. 1000)
--
-- SECTIONS:
--   A  — Financial Position Summary      (A.1 – A.5)
--   B  — Income Audit Trail              (B.1 – B.8)
--   C  — Expense Audit Trail             (C.1 – C.6)
--   D  — Harvest & Pledge Audit          (D.1 – D.4)
--   E  — Data Integrity Checks           (E.1 – E.6)
--   F  — User Activity & Access Audit    (F.1 – F.4)
--   G  — Auditor Summary & Exceptions    (G.1 – G.3)
-- =====================================================================


-- =====================================================================
-- SECTION A: FINANCIAL POSITION SUMMARY
-- =====================================================================


-- ---------- A.1  Complete Income Statement ----------------------------
-- All income streams vs expenses — the full P&L equivalent.
SELECT
    src.income_source,
    src.num_transactions,
    src.gross_income,
    NULL  AS total_expenses,
    NULL  AS net_balance
FROM (
    SELECT 'Service Offerings'            AS income_source,
           COUNT(*)                       AS num_transactions,
           COALESCE(SUM(total_amount), 0) AS gross_income
    FROM services
    WHERE service_date BETWEEN :start_date AND :end_date
      AND deleted_at IS NULL

    UNION ALL

    SELECT 'Harvest Collections',
           COUNT(*),
           COALESCE(SUM(total_collected), 0)
    FROM harvests
    WHERE COALESCE(harvest_date, harvest_year || '-01-01') BETWEEN :start_date AND :end_date
      AND deleted_at IS NULL

    UNION ALL

    SELECT 'Special Offerings',
           COUNT(*),
           COALESCE(SUM(amount), 0)
    FROM special_offerings
    WHERE offering_date BETWEEN :start_date AND :end_date
      AND deleted_at IS NULL
) src

UNION ALL

SELECT '─── TOTAL INCOME ───',
    (SELECT COUNT(*) FROM services
     WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    + (SELECT COUNT(*) FROM harvests
       WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    + (SELECT COUNT(*) FROM special_offerings
       WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),
    (SELECT COALESCE(SUM(total_amount),0) FROM services
     WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    + (SELECT COALESCE(SUM(total_collected),0) FROM harvests
       WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    + (SELECT COALESCE(SUM(amount),0) FROM special_offerings
       WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),
    NULL, NULL

UNION ALL SELECT '─────────────────────────────', NULL, NULL, NULL, NULL

UNION ALL
SELECT '─── TOTAL EXPENSES ───', NULL, NULL,
    COALESCE(SUM(amount), 0), NULL
FROM expenses
WHERE spent_on BETWEEN :start_date AND :end_date

UNION ALL
SELECT '─── NET SURPLUS / DEFICIT ───', NULL, NULL, NULL,
    (SELECT COALESCE(SUM(total_amount),0) FROM services
     WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    + (SELECT COALESCE(SUM(total_collected),0) FROM harvests
       WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    + (SELECT COALESCE(SUM(amount),0) FROM special_offerings
       WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    - (SELECT COALESCE(SUM(amount),0) FROM expenses
       WHERE spent_on BETWEEN :start_date AND :end_date);


-- ---------- A.2  Monthly Running Balance ------------------------------
-- Per-month income, expenses, net, and cumulative closing balance.
WITH all_months AS (
    SELECT DISTINCT strftime('%Y-%m', service_date) AS ym
    FROM services WHERE strftime('%Y', service_date) = :report_year AND deleted_at IS NULL
    UNION
    SELECT DISTINCT strftime('%Y-%m', COALESCE(harvest_date, harvest_year||'-01-01'))
    FROM harvests WHERE harvest_year = CAST(:report_year AS INTEGER) AND deleted_at IS NULL
    UNION
    SELECT DISTINCT strftime('%Y-%m', offering_date)
    FROM special_offerings WHERE strftime('%Y', offering_date) = :report_year AND deleted_at IS NULL
    UNION
    SELECT DISTINCT strftime('%Y-%m', spent_on)
    FROM expenses WHERE strftime('%Y', spent_on) = :report_year
),
mi AS (
    SELECT strftime('%Y-%m', service_date) AS ym, COALESCE(SUM(total_amount),0) AS amt
    FROM services WHERE strftime('%Y', service_date) = :report_year AND deleted_at IS NULL
    GROUP BY ym
),
mh AS (
    SELECT strftime('%Y-%m', COALESCE(harvest_date,harvest_year||'-01-01')) AS ym,
           COALESCE(SUM(total_collected),0) AS amt
    FROM harvests WHERE harvest_year = CAST(:report_year AS INTEGER) AND deleted_at IS NULL
    GROUP BY ym
),
ms AS (
    SELECT strftime('%Y-%m', offering_date) AS ym, COALESCE(SUM(amount),0) AS amt
    FROM special_offerings WHERE strftime('%Y', offering_date) = :report_year AND deleted_at IS NULL
    GROUP BY ym
),
me AS (
    SELECT strftime('%Y-%m', spent_on) AS ym, COALESCE(SUM(amount),0) AS amt
    FROM expenses WHERE strftime('%Y', spent_on) = :report_year
    GROUP BY ym
),
base AS (
    SELECT
        m.ym,
        COALESCE(mi.amt,0)                         AS service_income,
        COALESCE(mh.amt,0)                         AS harvest_income,
        COALESCE(ms.amt,0)                         AS special_income,
        COALESCE(mi.amt,0)+COALESCE(mh.amt,0)+COALESCE(ms.amt,0) AS total_income,
        COALESCE(me.amt,0)                         AS expenses,
        COALESCE(mi.amt,0)+COALESCE(mh.amt,0)+COALESCE(ms.amt,0)-COALESCE(me.amt,0) AS net
    FROM all_months m
    LEFT JOIN mi ON mi.ym = m.ym
    LEFT JOIN mh ON mh.ym = m.ym
    LEFT JOIN ms ON ms.ym = m.ym
    LEFT JOIN me ON me.ym = m.ym
)
SELECT
    ym            AS year_month,
    service_income,
    harvest_income,
    special_income,
    total_income,
    expenses,
    net           AS monthly_net,
    SUM(net) OVER (ORDER BY ym ROWS UNBOUNDED PRECEDING) AS cumulative_balance
FROM base
ORDER BY ym;


-- ---------- A.3  Income Breakdown by Source & Percentage --------------
WITH t AS (
    SELECT
        COALESCE((SELECT SUM(total_amount) FROM services
         WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0) AS svc,
        COALESCE((SELECT SUM(total_collected) FROM harvests
         WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0) AS hvst,
        COALESCE((SELECT SUM(amount) FROM special_offerings
         WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0) AS spl
)
SELECT 'Service Offerings' AS income_source, t.svc AS amount,
    ROUND(t.svc*100.0/NULLIF(t.svc+t.hvst+t.spl,0),2) AS pct_of_total,
    (SELECT COUNT(*) FROM services WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL) AS transactions
FROM t
UNION ALL
SELECT 'Harvest Collections', t.hvst,
    ROUND(t.hvst*100.0/NULLIF(t.svc+t.hvst+t.spl,0),2),
    (SELECT COUNT(*) FROM harvests
     WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
FROM t
UNION ALL
SELECT 'Special Offerings', t.spl,
    ROUND(t.spl*100.0/NULLIF(t.svc+t.hvst+t.spl,0),2),
    (SELECT COUNT(*) FROM special_offerings WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
FROM t
UNION ALL
SELECT 'GRAND TOTAL', t.svc+t.hvst+t.spl, 100.0,
    (SELECT COUNT(*) FROM services WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    +(SELECT COUNT(*) FROM harvests
      WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    +(SELECT COUNT(*) FROM special_offerings WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
FROM t;


-- ---------- A.4  Year-over-Year Financial Summary ---------------------
SELECT
    'Service Offerings' AS line_item,
    SUM(CASE WHEN strftime('%Y',service_date)=:year_a THEN total_amount ELSE 0 END) AS year_a,
    SUM(CASE WHEN strftime('%Y',service_date)=:year_b THEN total_amount ELSE 0 END) AS year_b,
    SUM(CASE WHEN strftime('%Y',service_date)=:year_a THEN total_amount ELSE 0 END)
    -SUM(CASE WHEN strftime('%Y',service_date)=:year_b THEN total_amount ELSE 0 END) AS variance,
    ROUND(
        (SUM(CASE WHEN strftime('%Y',service_date)=:year_a THEN total_amount ELSE 0 END)
        -SUM(CASE WHEN strftime('%Y',service_date)=:year_b THEN total_amount ELSE 0 END))
        *100.0/NULLIF(SUM(CASE WHEN strftime('%Y',service_date)=:year_b THEN total_amount ELSE 0 END),0),1) AS pct_change
FROM services WHERE deleted_at IS NULL
UNION ALL
SELECT 'Harvest Collections',
    SUM(CASE WHEN harvest_year=CAST(:year_a AS INTEGER) THEN total_collected ELSE 0 END),
    SUM(CASE WHEN harvest_year=CAST(:year_b AS INTEGER) THEN total_collected ELSE 0 END),
    SUM(CASE WHEN harvest_year=CAST(:year_a AS INTEGER) THEN total_collected ELSE 0 END)
    -SUM(CASE WHEN harvest_year=CAST(:year_b AS INTEGER) THEN total_collected ELSE 0 END),
    ROUND(
        (SUM(CASE WHEN harvest_year=CAST(:year_a AS INTEGER) THEN total_collected ELSE 0 END)
        -SUM(CASE WHEN harvest_year=CAST(:year_b AS INTEGER) THEN total_collected ELSE 0 END))
        *100.0/NULLIF(SUM(CASE WHEN harvest_year=CAST(:year_b AS INTEGER) THEN total_collected ELSE 0 END),0),1)
FROM harvests WHERE deleted_at IS NULL
UNION ALL
SELECT 'Special Offerings',
    SUM(CASE WHEN strftime('%Y',offering_date)=:year_a THEN amount ELSE 0 END),
    SUM(CASE WHEN strftime('%Y',offering_date)=:year_b THEN amount ELSE 0 END),
    SUM(CASE WHEN strftime('%Y',offering_date)=:year_a THEN amount ELSE 0 END)
    -SUM(CASE WHEN strftime('%Y',offering_date)=:year_b THEN amount ELSE 0 END),
    ROUND(
        (SUM(CASE WHEN strftime('%Y',offering_date)=:year_a THEN amount ELSE 0 END)
        -SUM(CASE WHEN strftime('%Y',offering_date)=:year_b THEN amount ELSE 0 END))
        *100.0/NULLIF(SUM(CASE WHEN strftime('%Y',offering_date)=:year_b THEN amount ELSE 0 END),0),1)
FROM special_offerings WHERE deleted_at IS NULL
UNION ALL
SELECT 'TOTAL EXPENSES',
    SUM(CASE WHEN strftime('%Y',spent_on)=:year_a THEN amount ELSE 0 END),
    SUM(CASE WHEN strftime('%Y',spent_on)=:year_b THEN amount ELSE 0 END),
    SUM(CASE WHEN strftime('%Y',spent_on)=:year_a THEN amount ELSE 0 END)
    -SUM(CASE WHEN strftime('%Y',spent_on)=:year_b THEN amount ELSE 0 END),
    ROUND(
        (SUM(CASE WHEN strftime('%Y',spent_on)=:year_a THEN amount ELSE 0 END)
        -SUM(CASE WHEN strftime('%Y',spent_on)=:year_b THEN amount ELSE 0 END))
        *100.0/NULLIF(SUM(CASE WHEN strftime('%Y',spent_on)=:year_b THEN amount ELSE 0 END),0),1)
FROM expenses;


-- ---------- A.5  Fund Balance (Opening → Closing) --------------------
-- Pass :opening_balance as the prior-period closing figure.
SELECT 'Opening Balance'              AS item, CAST(:opening_balance AS REAL) AS amount
UNION ALL
SELECT 'ADD: Service Offerings',
    COALESCE(SUM(total_amount),0) FROM services
    WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL
UNION ALL
SELECT 'ADD: Harvest Collections',
    COALESCE(SUM(total_collected),0) FROM harvests
    WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL
UNION ALL
SELECT 'ADD: Special Offerings',
    COALESCE(SUM(amount),0) FROM special_offerings
    WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL
UNION ALL
SELECT 'LESS: Expenses',
    -COALESCE(SUM(amount),0) FROM expenses
    WHERE spent_on BETWEEN :start_date AND :end_date
UNION ALL
SELECT '──────────────────', NULL
UNION ALL
SELECT 'CLOSING BALANCE',
    CAST(:opening_balance AS REAL)
    +(SELECT COALESCE(SUM(total_amount),0) FROM services
      WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    +(SELECT COALESCE(SUM(total_collected),0) FROM harvests
      WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    +(SELECT COALESCE(SUM(amount),0) FROM special_offerings
      WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    -(SELECT COALESCE(SUM(amount),0) FROM expenses
      WHERE spent_on BETWEEN :start_date AND :end_date);


-- =====================================================================
-- SECTION B: INCOME AUDIT TRAIL
-- =====================================================================


-- ---------- B.1  Complete Chronological Income Ledger -----------------
-- Every income transaction from every source, in date order.
SELECT
    'SVC'                           AS tx_type,
    s.service_id                    AS tx_id,
    s.service_date                  AS tx_date,
    st.type_name                    AS category,
    NULL                            AS sub_category,
    s.total_amount                  AS amount,
    COALESCE(u.display_name, '—')   AS recorded_by,
    COALESCE(u.role, '—')           AS recorder_role,
    s.notes,
    s.created_at                    AS entry_timestamp
FROM services s
JOIN service_types st ON st.service_type_id = s.service_type_id
LEFT JOIN users u     ON u.user_id          = s.recorded_by
WHERE s.service_date BETWEEN :start_date AND :end_date
  AND s.deleted_at IS NULL

UNION ALL

SELECT
    'HVST',
    h.harvest_id,
    COALESCE(h.harvest_date, h.harvest_year || '-01-01'),
    h.harvest_type,
    COALESCE(o.name, 'End-of-Year'),
    h.total_collected,
    COALESCE(u.display_name, '—'),
    COALESCE(u.role, '—'),
    h.theme,
    h.created_at
FROM harvests h
LEFT JOIN organizations o ON o.org_id  = h.org_id
LEFT JOIN users u         ON u.user_id = h.recorded_by
WHERE COALESCE(h.harvest_date, h.harvest_year||'-01-01') BETWEEN :start_date AND :end_date
  AND h.deleted_at IS NULL

UNION ALL

SELECT
    'SPL',
    sp.special_id,
    sp.offering_date,
    sc.category_name,
    sp.purpose,
    sp.amount,
    COALESCE(u.display_name, '—'),
    COALESCE(u.role, '—'),
    sp.receipt_number,
    sp.created_at
FROM special_offerings sp
JOIN special_categories sc ON sc.special_cat_id = sp.special_cat_id
LEFT JOIN users u           ON u.user_id         = sp.recorded_by
WHERE sp.offering_date BETWEEN :start_date AND :end_date
  AND sp.deleted_at IS NULL

ORDER BY tx_date, tx_type, tx_id;


-- ---------- B.2  Income by Recorder (Segregation Check) ---------------
SELECT
    COALESCE(u.display_name, 'Unknown') AS recorded_by,
    u.role,
    COUNT(*)             AS total_transactions,
    SUM(CASE WHEN src='SVC'  THEN amount ELSE 0 END) AS service_income_entered,
    SUM(CASE WHEN src='SPL'  THEN amount ELSE 0 END) AS special_income_entered,
    SUM(amount)          AS total_income_entered
FROM (
    SELECT recorded_by AS uid, 'SVC' AS src, total_amount AS amount
    FROM services WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL
    UNION ALL
    SELECT recorded_by, 'SPL', amount
    FROM special_offerings WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL
) t
LEFT JOIN users u ON u.user_id = t.uid
GROUP BY u.user_id, u.display_name, u.role
ORDER BY total_income_entered DESC;


-- ---------- B.3  Day-Born Split Reconciliation ------------------------
-- CRITICAL: confirms day-born splits for each service sum to total_amount.
-- Any row with status '*** MISMATCH ***' is an audit finding.
SELECT
    s.service_id,
    s.service_date,
    st.type_name                        AS service_type,
    s.total_amount                      AS recorded_service_total,
    COALESCE(SUM(dbs.amount), 0)        AS sum_of_dayborn_splits,
    s.total_amount - COALESCE(SUM(dbs.amount),0) AS discrepancy_amount,
    CASE
        WHEN s.total_amount = COALESCE(SUM(dbs.amount), 0) THEN 'OK'
        WHEN COALESCE(SUM(dbs.amount), 0) = 0              THEN 'NO SPLIT DATA'
        ELSE '*** MISMATCH ***'
    END AS reconciliation_status,
    COALESCE(u.display_name, '—') AS recorded_by
FROM services s
JOIN service_types st     ON st.service_type_id = s.service_type_id
LEFT JOIN users u         ON u.user_id          = s.recorded_by
LEFT JOIN day_born_splits dbs ON dbs.service_id = s.service_id
WHERE s.service_date BETWEEN :start_date AND :end_date
  AND s.deleted_at IS NULL
GROUP BY s.service_id, s.service_date, st.type_name, s.total_amount, u.display_name
ORDER BY reconciliation_status DESC, s.service_date;


-- ---------- B.4  Services With No Day-Born Split Data -----------------
SELECT
    s.service_id,
    s.service_date,
    st.type_name  AS service_type,
    s.total_amount,
    COALESCE(u.display_name,'—') AS recorded_by,
    s.notes
FROM services s
JOIN service_types st ON st.service_type_id = s.service_type_id
LEFT JOIN users u     ON u.user_id          = s.recorded_by
WHERE s.service_date BETWEEN :start_date AND :end_date
  AND s.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM day_born_splits dbs WHERE dbs.service_id = s.service_id
  )
ORDER BY s.service_date;


-- ---------- B.5  Unusual / Suspicious Income Entries ------------------
-- Flags zero amounts and values above :high_threshold.
SELECT
    'ZERO AMOUNT'  AS flag,
    'SVC' AS source, s.service_id AS tx_id, s.service_date AS tx_date,
    0 AS amount, COALESCE(u.display_name,'—') AS recorded_by, s.notes
FROM services s LEFT JOIN users u ON u.user_id = s.recorded_by
WHERE s.total_amount = 0 AND s.service_date BETWEEN :start_date AND :end_date AND s.deleted_at IS NULL

UNION ALL

SELECT 'HIGH VALUE', 'SVC', s.service_id, s.service_date,
    s.total_amount, COALESCE(u.display_name,'—'), s.notes
FROM services s LEFT JOIN users u ON u.user_id = s.recorded_by
WHERE s.total_amount > CAST(:high_threshold AS REAL)
  AND s.service_date BETWEEN :start_date AND :end_date AND s.deleted_at IS NULL

UNION ALL

SELECT 'HIGH VALUE', 'SPL', sp.special_id, sp.offering_date,
    sp.amount, COALESCE(u.display_name,'—'), sp.purpose
FROM special_offerings sp LEFT JOIN users u ON u.user_id = sp.recorded_by
WHERE sp.amount > CAST(:high_threshold AS REAL)
  AND sp.offering_date BETWEEN :start_date AND :end_date AND sp.deleted_at IS NULL

ORDER BY flag, tx_date;


-- ---------- B.6  Duplicate Transaction Detector -----------------------
-- Same date + same service type + same amount = likely double entry.
SELECT
    s.service_date,
    st.type_name,
    s.total_amount,
    COUNT(*)                   AS duplicate_count,
    GROUP_CONCAT(s.service_id) AS service_ids,
    GROUP_CONCAT(COALESCE(u.display_name,'—')) AS recorded_by_list
FROM services s
JOIN service_types st ON st.service_type_id = s.service_type_id
LEFT JOIN users u     ON u.user_id          = s.recorded_by
WHERE s.service_date BETWEEN :start_date AND :end_date
  AND s.deleted_at IS NULL
GROUP BY s.service_date, s.service_type_id, s.total_amount
HAVING COUNT(*) > 1
ORDER BY s.service_date;


-- ---------- B.7  Week-over-Week Income Variance -----------------------
-- Flags weeks where collections dropped or spiked more than 20%.
WITH weekly AS (
    SELECT strftime('%Y-W%W', service_date) AS iso_week,
           SUM(total_amount)                AS weekly_total
    FROM services
    WHERE strftime('%Y', service_date) = :report_year AND deleted_at IS NULL
    GROUP BY iso_week
),
lagged AS (
    SELECT iso_week, weekly_total,
           LAG(weekly_total) OVER (ORDER BY iso_week) AS prev_week_total
    FROM weekly
)
SELECT
    iso_week, weekly_total, prev_week_total,
    ROUND((weekly_total-prev_week_total)*100.0/NULLIF(prev_week_total,0),1) AS pct_change,
    CASE
        WHEN prev_week_total IS NULL THEN 'First Week'
        WHEN (weekly_total-prev_week_total)*100.0/NULLIF(prev_week_total,0) < -20 THEN 'DROP >20%'
        WHEN (weekly_total-prev_week_total)*100.0/NULLIF(prev_week_total,0) >  20 THEN 'SPIKE >20%'
        ELSE 'Normal'
    END AS variance_flag
FROM lagged
ORDER BY iso_week;


-- ---------- B.8  Special Offerings — Receipt Completeness Audit -------
SELECT
    sp.special_id,
    sp.offering_date,
    sc.category_name,
    COALESCE(m.first_name||' '||m.last_name, sp.donor_name_manual, 'Anonymous') AS donor,
    sp.amount,
    sp.receipt_number,
    CASE WHEN sp.receipt_number IS NULL OR sp.receipt_number = ''
         THEN '*** NO RECEIPT ***' ELSE 'OK' END AS receipt_status,
    COALESCE(u.display_name,'—') AS recorded_by
FROM special_offerings sp
JOIN special_categories sc ON sc.special_cat_id = sp.special_cat_id
LEFT JOIN members m        ON m.member_id       = sp.donor_id
LEFT JOIN users u          ON u.user_id         = sp.recorded_by
WHERE sp.offering_date BETWEEN :start_date AND :end_date
  AND sp.deleted_at IS NULL
ORDER BY receipt_status DESC, sp.offering_date;


-- =====================================================================
-- SECTION C: EXPENSE AUDIT TRAIL
-- =====================================================================


-- ---------- C.1  Complete Chronological Expense Ledger ----------------
SELECT
    e.expense_id,
    e.spent_on                                  AS expense_date,
    COALESCE(ec.category_name, e.category)      AS category,
    e.description,
    e.amount,
    e.payment_method,
    e.paid_to,
    e.reference_number,
    COALESCE(u_app.display_name, 'NOT APPROVED') AS approved_by,
    COALESCE(u_app.role, '—')                    AS approver_role,
    CASE WHEN e.receipt_attached=1 THEN 'Yes' ELSE 'MISSING' END AS receipt,
    CASE WHEN e.approved_by IS NULL THEN 'PENDING' ELSE 'Approved' END AS approval_status,
    e.created_at
FROM expenses e
LEFT JOIN expense_categories ec ON ec.expense_cat_id = e.expense_cat_id
LEFT JOIN users u_app           ON u_app.user_id     = e.approved_by
WHERE e.spent_on BETWEEN :start_date AND :end_date
ORDER BY e.spent_on, e.expense_id;


-- ---------- C.2  Unapproved Expenses ----------------------------------
SELECT
    e.expense_id,
    e.spent_on,
    COALESCE(ec.category_name, e.category) AS category,
    e.description,
    e.amount,
    e.payment_method,
    e.paid_to,
    ROUND(julianday('now') - julianday(e.spent_on)) AS days_pending
FROM expenses e
LEFT JOIN expense_categories ec ON ec.expense_cat_id = e.expense_cat_id
WHERE e.approved_by IS NULL
  AND e.spent_on BETWEEN :start_date AND :end_date
ORDER BY e.spent_on;


-- ---------- C.3  Expenses Without Receipts ----------------------------
SELECT
    e.expense_id,
    e.spent_on,
    COALESCE(ec.category_name, e.category) AS category,
    e.description,
    e.amount,
    e.payment_method,
    e.paid_to,
    COALESCE(u.display_name, 'NOT APPROVED') AS approved_by
FROM expenses e
LEFT JOIN expense_categories ec ON ec.expense_cat_id = e.expense_cat_id
LEFT JOIN users u               ON u.user_id         = e.approved_by
WHERE e.receipt_attached = 0
  AND e.spent_on BETWEEN :start_date AND :end_date
ORDER BY e.amount DESC;


-- ---------- C.4  Large / Unusual Expense Transactions -----------------
SELECT
    e.expense_id,
    e.spent_on,
    COALESCE(ec.category_name, e.category) AS category,
    e.description,
    e.amount,
    e.payment_method,
    e.paid_to,
    e.reference_number,
    COALESCE(u.display_name, 'NOT APPROVED') AS approved_by,
    CASE WHEN e.receipt_attached=1 THEN 'Yes' ELSE 'MISSING' END AS receipt
FROM expenses e
LEFT JOIN expense_categories ec ON ec.expense_cat_id = e.expense_cat_id
LEFT JOIN users u               ON u.user_id         = e.approved_by
WHERE e.amount > CAST(:expense_threshold AS REAL)
  AND e.spent_on BETWEEN :start_date AND :end_date
ORDER BY e.amount DESC;


-- ---------- C.5  Expense Category Summary with Approval Status --------
SELECT
    COALESCE(ec.category_name, e.category) AS category,
    COUNT(*)                               AS num_expenses,
    SUM(e.amount)                          AS total_spent,
    AVG(e.amount)                          AS avg_expense,
    SUM(CASE WHEN e.approved_by IS NULL  THEN 1 ELSE 0 END) AS unapproved_count,
    SUM(CASE WHEN e.receipt_attached = 0 THEN 1 ELSE 0 END) AS missing_receipts,
    SUM(CASE WHEN e.approved_by IS NULL  THEN e.amount ELSE 0 END) AS unapproved_value
FROM expenses e
LEFT JOIN expense_categories ec ON ec.expense_cat_id = e.expense_cat_id
WHERE e.spent_on BETWEEN :start_date AND :end_date
GROUP BY COALESCE(ec.category_name, e.category)
ORDER BY total_spent DESC;


-- ---------- C.6  Payment Method Breakdown -----------------------------
SELECT
    COALESCE(e.payment_method, 'Unspecified') AS payment_method,
    COUNT(*)            AS num_transactions,
    SUM(e.amount)       AS total_amount,
    SUM(CASE WHEN e.receipt_attached=0 THEN 1 ELSE 0 END) AS missing_receipts,
    SUM(CASE WHEN e.approved_by IS NULL THEN 1 ELSE 0 END) AS unapproved_count
FROM expenses e
WHERE e.spent_on BETWEEN :start_date AND :end_date
GROUP BY payment_method
ORDER BY total_amount DESC;


-- =====================================================================
-- SECTION D: HARVEST & PLEDGE AUDIT
-- =====================================================================


-- ---------- D.1  Full Pledge vs Payment Audit per Member --------------
SELECT
    m.member_id,
    m.first_name || ' ' || m.last_name AS member_name,
    m.day_born,
    (SELECT GROUP_CONCAT(o.name, ', ')
     FROM organization_memberships om JOIN organizations o ON o.org_id=om.org_id
     WHERE om.member_id=m.member_id LIMIT 1)  AS organizations,
    h.harvest_name,
    h.harvest_year,
    p.pledged_amount,
    p.paid_amount,
    p.pledged_amount - p.paid_amount  AS outstanding,
    ROUND(p.paid_amount*100.0/NULLIF(p.pledged_amount,0),1) AS pct_fulfilled,
    p.status,
    CASE
        WHEN p.paid_amount > p.pledged_amount THEN '*** OVERPAID ***'
        WHEN p.paid_amount = p.pledged_amount THEN 'Fulfilled'
        WHEN p.paid_amount > 0               THEN 'Partial'
        ELSE 'Unpaid'
    END AS audit_status
FROM pledges p
JOIN members m  ON m.member_id  = p.member_id
JOIN harvests h ON h.harvest_id = p.harvest_id
WHERE h.harvest_year = CAST(:report_year AS INTEGER)
ORDER BY audit_status, outstanding DESC;


-- ---------- D.2  Harvest Reconciliation — Pledges vs Collected --------
SELECT
    h.harvest_id,
    h.harvest_name,
    h.harvest_year,
    h.harvest_type,
    h.total_collected                          AS harvest_recorded_total,
    COALESCE(SUM(p.paid_amount),0)             AS sum_of_pledge_payments,
    h.total_collected - COALESCE(SUM(p.paid_amount),0) AS unaccounted_balance,
    CASE
        WHEN COALESCE(SUM(p.paid_amount),0) > h.total_collected
             THEN '*** PLEDGES EXCEED RECORDED TOTAL ***'
        WHEN COALESCE(SUM(p.paid_amount),0) = h.total_collected THEN 'Balanced'
        ELSE 'Unallocated Balance'
    END AS reconciliation_status
FROM harvests h
LEFT JOIN pledges p ON p.harvest_id = h.harvest_id
WHERE h.harvest_year = CAST(:report_year AS INTEGER)
  AND h.deleted_at IS NULL
GROUP BY h.harvest_id, h.harvest_name, h.harvest_year, h.harvest_type, h.total_collected
ORDER BY reconciliation_status, h.harvest_year;


-- ---------- D.3  Top Pledge Defaulters (Outstanding > 0) --------------
SELECT
    RANK() OVER (ORDER BY SUM(p.pledged_amount-p.paid_amount) DESC) AS rank,
    m.first_name || ' ' || m.last_name AS member_name,
    m.day_born,
    SUM(p.pledged_amount)              AS total_pledged,
    SUM(p.paid_amount)                 AS total_paid,
    SUM(p.pledged_amount-p.paid_amount) AS total_outstanding
FROM pledges p
JOIN members m  ON m.member_id  = p.member_id
JOIN harvests h ON h.harvest_id = p.harvest_id
WHERE h.harvest_year = CAST(:report_year AS INTEGER)
  AND p.paid_amount < p.pledged_amount
GROUP BY m.member_id, m.first_name, m.last_name, m.day_born
ORDER BY total_outstanding DESC;


-- ---------- D.4  Overpaid Pledges (Data Anomaly) ----------------------
SELECT
    m.first_name || ' ' || m.last_name AS member_name,
    h.harvest_name,
    p.pledged_amount,
    p.paid_amount,
    p.paid_amount - p.pledged_amount  AS excess_paid,
    '*** PAID MORE THAN PLEDGED ***'  AS flag
FROM pledges p
JOIN members m  ON m.member_id  = p.member_id
JOIN harvests h ON h.harvest_id = p.harvest_id
WHERE p.paid_amount > p.pledged_amount
ORDER BY excess_paid DESC;


-- =====================================================================
-- SECTION E: DATA INTEGRITY CHECKS
-- =====================================================================


-- ---------- E.1  Services With Zero or Negative Amounts ---------------
SELECT service_id, service_date, total_amount, notes,
       '*** INVALID AMOUNT ***' AS flag
FROM services WHERE total_amount <= 0 AND deleted_at IS NULL;


-- ---------- E.2  Expenses With Zero or Negative Amounts ---------------
SELECT expense_id, spent_on, amount, description,
       '*** INVALID AMOUNT ***' AS flag
FROM expenses WHERE amount <= 0;


-- ---------- E.3  Orphaned Day-Born Splits (no parent service) ---------
SELECT dbs.split_id, dbs.service_id, dbs.day_born, dbs.amount,
       '*** NO PARENT SERVICE ***' AS flag
FROM day_born_splits dbs
WHERE dbs.service_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM services s WHERE s.service_id = dbs.service_id);


-- ---------- E.4  Pledges Referencing Missing Members or Harvests ------
SELECT
    p.pledge_id, p.member_id, p.harvest_id,
    CASE WHEN m.member_id IS NULL THEN '*** MEMBER NOT FOUND ***' ELSE 'OK' END AS member_flag,
    CASE WHEN h.harvest_id IS NULL THEN '*** HARVEST NOT FOUND ***' ELSE 'OK' END AS harvest_flag
FROM pledges p
LEFT JOIN members m  ON m.member_id  = p.member_id
LEFT JOIN harvests h ON h.harvest_id = p.harvest_id
WHERE m.member_id IS NULL OR h.harvest_id IS NULL;


-- ---------- E.5  Special Offerings With No Category Link --------------
SELECT sp.special_id, sp.offering_date, sp.amount, sp.purpose,
       '*** NO CATEGORY ***' AS flag
FROM special_offerings sp
WHERE sp.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM special_categories sc WHERE sc.special_cat_id = sp.special_cat_id
  );


-- ---------- E.6  Future-Dated Transactions ----------------------------
SELECT 'SERVICE'  AS tx_type, service_id AS tx_id, service_date AS tx_date,
       total_amount AS amount, '*** FUTURE DATE ***' AS flag
FROM services WHERE service_date > date('now') AND deleted_at IS NULL
UNION ALL
SELECT 'EXPENSE', expense_id, spent_on, amount, '*** FUTURE DATE ***'
FROM expenses WHERE spent_on > date('now')
UNION ALL
SELECT 'SPECIAL', special_id, offering_date, amount, '*** FUTURE DATE ***'
FROM special_offerings WHERE offering_date > date('now') AND deleted_at IS NULL
ORDER BY tx_date;


-- =====================================================================
-- SECTION F: USER ACTIVITY & ACCESS AUDIT
-- =====================================================================
-- Note: activity_log records user actions with kind + description.
--       security_audit_log records login/access events with IP + user-agent.


-- ---------- F.1  Full Finance Activity Log ----------------------------
SELECT
    a.occurred_at,
    COALESCE(u.display_name, 'Unknown') AS user_name,
    u.role,
    a.kind,
    a.description,
    a.link
FROM activity_log a
LEFT JOIN users u ON u.user_id = a.user_id
WHERE a.occurred_at BETWEEN :start_date AND :end_date || ' 23:59:59'
  AND a.kind IN (
      'contribution_recorded','expense_recorded','expense_edited',
      'pledge_payment','pledge_edited','receipt_sent','statement_sent',
      'harvest_recorded','harvest_edited','special_offering_recorded'
  )
ORDER BY a.occurred_at DESC;


-- ---------- F.2  Edit Actions Only (Changes to Existing Records) ------
SELECT
    a.occurred_at,
    COALESCE(u.display_name,'Unknown') AS user_name,
    u.role,
    a.kind,
    a.description,
    a.link
FROM activity_log a
LEFT JOIN users u ON u.user_id = a.user_id
WHERE a.occurred_at BETWEEN :start_date AND :end_date || ' 23:59:59'
  AND a.kind LIKE '%_edited'
ORDER BY a.occurred_at DESC;


-- ---------- F.3  Per-User Activity Summary ----------------------------
SELECT
    COALESCE(u.display_name,'Unknown') AS user_name,
    u.role,
    COUNT(*)                           AS total_finance_actions,
    SUM(CASE WHEN a.kind LIKE '%_recorded' THEN 1 ELSE 0 END) AS records_created,
    SUM(CASE WHEN a.kind LIKE '%_edited'   THEN 1 ELSE 0 END) AS records_edited,
    SUM(CASE WHEN a.kind = 'receipt_sent' OR a.kind = 'statement_sent' THEN 1 ELSE 0 END) AS communications_sent,
    MIN(a.occurred_at) AS first_action,
    MAX(a.occurred_at) AS last_action
FROM activity_log a
LEFT JOIN users u ON u.user_id = a.user_id
WHERE a.occurred_at BETWEEN :start_date AND :end_date || ' 23:59:59'
  AND a.kind IN (
      'contribution_recorded','expense_recorded','expense_edited',
      'pledge_payment','pledge_edited','receipt_sent','statement_sent'
  )
GROUP BY u.user_id, u.display_name, u.role
ORDER BY total_finance_actions DESC;


-- ---------- F.4  Security Access Log (Login / Session Events) ---------
SELECT
    sal.occurred_at,
    COALESCE(u.display_name,'Unknown') AS user_name,
    u.role,
    sal.event,
    sal.subject,
    sal.ip,
    sal.user_agent
FROM security_audit_log sal
LEFT JOIN users u ON u.user_id = sal.actor_id
WHERE sal.occurred_at BETWEEN :start_date AND :end_date || ' 23:59:59'
ORDER BY sal.occurred_at DESC;


-- =====================================================================
-- SECTION G: AUDITOR SUMMARY & EXCEPTIONS REPORT
-- =====================================================================


-- ---------- G.1  Executive Audit Summary (One-Page Overview) ----------
SELECT 'AUDIT PERIOD'                                    AS metric,
       :start_date || ' to ' || :end_date                AS value
UNION ALL SELECT '──────── INCOME ────────', '─────────────────'
UNION ALL
SELECT 'Service Offerings Income',
    CAST(COALESCE((SELECT SUM(total_amount) FROM services
     WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0) AS TEXT)
UNION ALL
SELECT 'Harvest Collections Income',
    CAST(COALESCE((SELECT SUM(total_collected) FROM harvests
     WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0) AS TEXT)
UNION ALL
SELECT 'Special Offerings Income',
    CAST(COALESCE((SELECT SUM(amount) FROM special_offerings
     WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0) AS TEXT)
UNION ALL
SELECT 'TOTAL INCOME',
    CAST(
        COALESCE((SELECT SUM(total_amount) FROM services
         WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0)
        +COALESCE((SELECT SUM(total_collected) FROM harvests
         WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0)
        +COALESCE((SELECT SUM(amount) FROM special_offerings
         WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0)
    AS TEXT)
UNION ALL SELECT '──────── EXPENSES ────────', '─────────────────'
UNION ALL
SELECT 'TOTAL EXPENSES',
    CAST(COALESCE((SELECT SUM(amount) FROM expenses WHERE spent_on BETWEEN :start_date AND :end_date),0) AS TEXT)
UNION ALL SELECT '──────── NET ────────', '─────────────────'
UNION ALL
SELECT 'NET SURPLUS / DEFICIT',
    CAST(
        COALESCE((SELECT SUM(total_amount) FROM services
         WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0)
        +COALESCE((SELECT SUM(total_collected) FROM harvests
         WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0)
        +COALESCE((SELECT SUM(amount) FROM special_offerings
         WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL),0)
        -COALESCE((SELECT SUM(amount) FROM expenses WHERE spent_on BETWEEN :start_date AND :end_date),0)
    AS TEXT)
UNION ALL SELECT '──────── CONTROLS ────────', '─────────────────'
UNION ALL
SELECT 'Services Held',
    CAST((SELECT COUNT(*) FROM services WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL) AS TEXT)
UNION ALL
SELECT 'Total Income Transactions',
    CAST(
        (SELECT COUNT(*) FROM services WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
        +(SELECT COUNT(*) FROM harvests WHERE COALESCE(harvest_date,harvest_year||'-01-01') BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
        +(SELECT COUNT(*) FROM special_offerings WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL)
    AS TEXT)
UNION ALL
SELECT 'Total Expense Transactions',
    CAST((SELECT COUNT(*) FROM expenses WHERE spent_on BETWEEN :start_date AND :end_date) AS TEXT)
UNION ALL
SELECT 'Unapproved Expenses',
    CAST((SELECT COUNT(*) FROM expenses WHERE approved_by IS NULL AND spent_on BETWEEN :start_date AND :end_date) AS TEXT)
UNION ALL
SELECT 'Expenses Without Receipts',
    CAST((SELECT COUNT(*) FROM expenses WHERE receipt_attached=0 AND spent_on BETWEEN :start_date AND :end_date) AS TEXT)
UNION ALL
SELECT 'Day-Born Split Mismatches',
    CAST((SELECT COUNT(*) FROM (
        SELECT s.service_id FROM services s
        LEFT JOIN day_born_splits dbs ON dbs.service_id = s.service_id
        WHERE s.service_date BETWEEN :start_date AND :end_date AND s.deleted_at IS NULL
        GROUP BY s.service_id, s.total_amount
        HAVING s.total_amount != COALESCE(SUM(dbs.amount),0)
    )) AS TEXT)
UNION ALL
SELECT 'Special Offerings Missing Receipts',
    CAST((SELECT COUNT(*) FROM special_offerings
     WHERE (receipt_number IS NULL OR receipt_number='')
       AND offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL) AS TEXT)
UNION ALL
SELECT 'Duplicate Service Entries',
    CAST((SELECT COUNT(*) FROM (
        SELECT service_date, service_type_id, total_amount
        FROM services WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL
        GROUP BY service_date, service_type_id, total_amount
        HAVING COUNT(*) > 1
    )) AS TEXT);


-- ---------- G.2  Consolidated Exceptions Report -----------------------
-- All audit findings in one result-set, ranked HIGH → MEDIUM → LOW.
SELECT
    'HIGH' AS severity, 'Day-Born Reconciliation Failure' AS finding_type,
    s.service_id AS record_id, s.service_date AS tx_date, 'Service' AS module,
    s.total_amount AS amount,
    COALESCE(u.display_name,'—') AS responsible_user,
    'Split total (' || CAST(COALESCE(SUM(dbs.amount),0) AS TEXT)
    || ') ≠ service total (' || CAST(s.total_amount AS TEXT) || ')' AS detail
FROM services s
LEFT JOIN users u ON u.user_id = s.recorded_by
LEFT JOIN day_born_splits dbs ON dbs.service_id = s.service_id
WHERE s.service_date BETWEEN :start_date AND :end_date AND s.deleted_at IS NULL
GROUP BY s.service_id, s.service_date, s.total_amount, u.display_name
HAVING s.total_amount != COALESCE(SUM(dbs.amount),0)

UNION ALL

SELECT
    'MEDIUM', 'Unapproved Expense',
    e.expense_id, e.spent_on, 'Expense', e.amount,
    NULL,
    'Expense recorded but no approver on record'
FROM expenses e
WHERE e.approved_by IS NULL AND e.spent_on BETWEEN :start_date AND :end_date

UNION ALL

SELECT
    'MEDIUM', 'Missing Receipt (Expense)',
    e.expense_id, e.spent_on, 'Expense', e.amount,
    NULL,
    'No receipt attached for expense: ' || COALESCE(e.description,'—')
FROM expenses e
WHERE e.receipt_attached=0 AND e.spent_on BETWEEN :start_date AND :end_date

UNION ALL

SELECT
    'MEDIUM', 'Missing Receipt (Special Offering)',
    sp.special_id, sp.offering_date, 'Special Offering', sp.amount,
    COALESCE(u.display_name,'—'),
    'No receipt # for offering from ' || COALESCE(m.first_name||' '||m.last_name, sp.donor_name_manual, 'Anonymous')
FROM special_offerings sp
LEFT JOIN users u   ON u.user_id   = sp.recorded_by
LEFT JOIN members m ON m.member_id = sp.donor_id
WHERE (sp.receipt_number IS NULL OR sp.receipt_number='')
  AND sp.offering_date BETWEEN :start_date AND :end_date AND sp.deleted_at IS NULL

UNION ALL

SELECT
    'LOW', 'Duplicate Entry Suspected',
    MIN(service_id), service_date, 'Service', total_amount, NULL,
    COUNT(*) || ' services with identical date, type and amount'
FROM services
WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL
GROUP BY service_date, service_type_id, total_amount
HAVING COUNT(*) > 1

ORDER BY
    CASE severity WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
    tx_date DESC;


-- ---------- G.3  Authorisation & Signatory Completeness ---------------
SELECT
    'Service Offering'  AS record_type,
    COUNT(*)            AS total_records,
    SUM(CASE WHEN recorded_by IS NOT NULL THEN 1 ELSE 0 END) AS has_recorder,
    SUM(CASE WHEN recorded_by IS NULL     THEN 1 ELSE 0 END) AS missing_recorder,
    NULL AS has_approver, NULL AS missing_approver
FROM services
WHERE service_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL

UNION ALL

SELECT
    'Expense',
    COUNT(*),
    NULL, NULL,
    SUM(CASE WHEN approved_by IS NOT NULL THEN 1 ELSE 0 END),
    SUM(CASE WHEN approved_by IS NULL     THEN 1 ELSE 0 END)
FROM expenses
WHERE spent_on BETWEEN :start_date AND :end_date

UNION ALL

SELECT
    'Special Offering',
    COUNT(*),
    SUM(CASE WHEN recorded_by IS NOT NULL THEN 1 ELSE 0 END),
    SUM(CASE WHEN recorded_by IS NULL     THEN 1 ELSE 0 END),
    NULL, NULL
FROM special_offerings
WHERE offering_date BETWEEN :start_date AND :end_date AND deleted_at IS NULL;


-- =====================================================================
-- END OF AUDIT QUERIES
-- =====================================================================
-- INDEX:
--   A.1  Complete Income Statement
--   A.2  Monthly Running Balance (cumulative)
--   A.3  Income by Source & Percentage
--   A.4  Year-over-Year Summary with Variance
--   A.5  Fund Balance (Opening → Closing)
--   B.1  Complete Chronological Income Ledger
--   B.2  Income by Recorder (Segregation Check)
--   B.3  Day-Born Split Reconciliation *** KEY AUDIT CHECK ***
--   B.4  Services With No Day-Born Data
--   B.5  Unusual / Suspicious Income Entries
--   B.6  Duplicate Transaction Detector
--   B.7  Week-over-Week Variance (>20% flag)
--   B.8  Special Offerings Receipt Completeness
--   C.1  Complete Expense Ledger
--   C.2  Unapproved Expenses
--   C.3  Expenses Without Receipts
--   C.4  Large / Unusual Expense Transactions
--   C.5  Expense Category Summary with Approval Status
--   C.6  Payment Method Breakdown
--   D.1  Full Pledge vs Payment Audit per Member
--   D.2  Harvest Reconciliation (Pledges vs Collected)
--   D.3  Top Pledge Defaulters
--   D.4  Overpaid Pledges (Anomaly)
--   E.1  Services With Zero/Negative Amounts
--   E.2  Expenses With Zero/Negative Amounts
--   E.3  Orphaned Day-Born Splits
--   E.4  Pledges Referencing Missing Members/Harvests
--   E.5  Special Offerings With No Category
--   E.6  Future-Dated Transactions
--   F.1  Finance Activity Log
--   F.2  Edit Actions Only
--   F.3  Per-User Activity Summary
--   F.4  Security Access Log (Login Events)
--   G.1  Executive Audit Summary (One Page)
--   G.2  Consolidated Exceptions Report (HIGH/MEDIUM/LOW)
--   G.3  Authorisation & Signatory Completeness
-- =====================================================================
