# Commercial Readiness Playbook

Use this playbook when presenting Church Manager to a new church, circuit, or
denomination office.

> **What this describes is what actually ships.** An earlier version of this
> document pitched three tiers (Starter / Pro / Enterprise) and a "private
> deployment per church". Neither is true: the product is one shared
> multi-tenant application with two plans, Free and Pro, and every church is
> isolated by tenant scoping inside it — not by having its own server. Selling
> the old story would promise something the software does not do.

## Ideal customer profile

- Churches with 100+ active members and recurring weekly services.
- Churches tracking offerings, tithes, harvests, attendance, organizations, and
  member follow-up in spreadsheets or notebooks.
- Leadership teams that need reports for stewardship, accountability,
  birthdays, attendance, and giving statements.

## Packaging

Two plans, defined in `lib/plan.js` and enforced at the point of use.

| Plan | Price | Staff accounts | Reports | Everything else |
|---|---|---|---|---|
| Free | — | 2 | ✗ | Included |
| Pro | Set per church | Unlimited | ✓ | Included |

"Everything else" is not a shortened list: members, attendance, events and
check-in, the full finance module (ledger, funds, tithes, offerings, harvests,
pledges, receipts, budgets, vouchers, projects, periods), communications,
inventory, Bible classes, organizations, preaching plan, CSV exports, roles,
2FA and the audit log are all on both plans. Free is a working system for a
small church, not a crippled demo.

**How a church becomes Pro.** Today this is manual: take payment out of band,
then set the plan in the platform portal (`/platform` → the church → Plan),
optionally with an expiry. There is **no payment integration in the product** —
no card or mobile-money checkout, no self-serve upgrade, no invoicing, no
automatic renewal or dunning. Every one of those is a conversation you have to
have yourself, and a step you have to remember to perform.

A lapsed `proUntil` returns the church to Free automatically. Nothing is
deleted when that happens: staff accounts over the limit keep working and keep
their data, the church simply cannot add more, and reports stop being served
until the plan is renewed.

## Demo workflow

1. **Discovery (5 minutes)**
   - Ask how they currently manage members, offerings, attendance, SMS, and
     reports.
   - Identify the biggest pain: missing records, manual reports, communication
     gaps, or finance reconciliation.
2. **Product walkthrough (20 minutes)**
   - Dashboard overview.
   - Members and profiles.
   - Finance and giving statements.
   - Attendance/events.
   - Reports and CSV exports — note these are Pro.
   - Inventory and organizations.
3. **Trust and operations (5 minutes)**
   - Explain tenant isolation: one system, each church sees only its own data.
   - Explain backups, health checks, security audit log, and role-based access.
4. **Close (5 minutes)**
   - Confirm plan fit and agree the Pro price if applicable.
   - Agree data-import format.
   - Schedule onboarding and training.
   - If they are going Pro, agree how they will pay and set the plan by hand.

## Onboarding checklist

- [ ] Church name, logo/branding, and preferred app URL.
- [ ] Member spreadsheet export.
- [ ] User list for pastor, secretary, treasurer, and viewers — check the count
      against the plan's seat limit before promising accounts.
- [ ] SMS sender ID and Arkesel API key if SMS is enabled.
- [ ] Opening finance categories/funds and reporting expectations.
- [ ] Training date for secretary/treasurer/pastor.
- [ ] If Pro: payment taken, plan set in the platform portal, expiry recorded.

## Sales proof points

- Ghana cedi finance workflows on a real double-entry ledger, with period
  locking and reversals rather than editable history.
- Harvests, pledges, day-born offerings, and giving statements.
- Tenant isolation enforced at a single data-access choke point, with a CI
  check that fails the build on unscoped raw SQL.
- Nightly offsite backups with verified failure alerting.
- Health/readiness checks and documented deployment and rollback runbooks.
- Security audit log for account and login activity; 2FA available per user.

## Known gaps — say these plainly if asked

- **No payment integration.** Upgrades are manual, both the collection and the
  switch.
- **No custom domain yet.** The app is served from a `.fly.dev` address.
- **No self-serve plan change.** A church cannot upgrade itself.
- **No usage-based billing or invoicing.** There is nothing to reconcile
  against, so keep your own record of who has paid and until when.

## Post-sale success metrics

- First admin created within 24 hours.
- Member import completed within 3 business days.
- First finance report generated within 1 week.
- First birthday/announcement communication sent within 2 weeks.
- Monthly backup verification completed and recorded.
- For Pro churches: expiry date recorded somewhere you will actually see it
  before it lapses.
