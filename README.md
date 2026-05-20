# Church Manager

A small web app for managing a local church: members, households,
ministries, events & attendance, contributions, sacraments, and pastoral
care notes. Built on Node.js + Express + SQLite (better-sqlite3),
server-rendered HTML with a simple stylesheet — no build step.

## Quick start

```bash
./build.sh           # creates church.db from schema.sql + seed.sql
npm install
npm start            # http://localhost:3000
```

Set `PORT` or `CHURCH_DB` to override defaults.

## What's in the UI

- **Dashboard** — active-member count, household count, YTD giving,
  upcoming events, latest contributions.
- **Members** — searchable list with status filter; detail page with
  edit form, ministries, sacraments, giving history, attendance.
- **Households** — list with member counts.
- **Ministries** — rosters with leader, meeting time, and members.
- **Events** — list, create new, and per-event check-in (add/remove
  attendees from a member picker).
- **Contributions** — record new contribution, see recent giving,
  YTD totals by fund.
- **Reports** — service attendance trend, top givers, monthly birthdays,
  "missed last 3 Sundays" follow-up list.

## Files

| File          | Purpose                                          |
|---------------|--------------------------------------------------|
| `server.js`   | Express server with all routes                   |
| `public/`     | Static assets (CSS)                              |
| `schema.sql`  | Tables, indexes, reporting views                 |
| `seed.sql`    | Sample data                                      |
| `queries.sql` | SQL reports you can run directly with `sqlite3`  |
| `build.sh`    | Builds `church.db` from schema + seed            |

## Schema overview

- **households** — family units with a shared address.
- **members** — individuals; linked to a household. Tracks contact info,
  membership status, join date, baptism.
- **ministries** + **ministry_memberships** — groups/teams and who's in them.
- **events** + **attendance** — services, studies, outreach; who attended.
- **funds** + **contributions** — tithes and offerings, by fund.
- **sacraments** — baptisms, marriages, dedications, etc.
- **pastoral_notes** — visits, calls, prayer requests, counseling.

Three convenience views ship with the schema:
`v_active_members`, `v_giving_by_member_year`, `v_event_attendance_counts`.

## Direct SQL

You can also work with the DB straight from the shell:

```bash
sqlite3 church.db
sqlite3 church.db < queries.sql   # built-in reports
```
