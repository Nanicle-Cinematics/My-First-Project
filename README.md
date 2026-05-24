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

The first time you load the site you'll be sent to **/setup** to create
an admin account. After that everyone has to sign in to use the app.

For deployments, set a long random `SESSION_SECRET` env var so logins
survive restarts:

```bash
SESSION_SECRET="$(openssl rand -hex 32)" npm start
```

## Accounts & roles

- The first visitor sees **/setup** and creates the initial admin.
- Admins can manage data (members, events, contributions) and other
  users via **/users**.
- Viewers can sign in and browse all pages but cannot edit anything.
- Anyone can change their own password at **/profile**.

## Deployment

The app boots from `schema.sql` automatically when the configured DB
file doesn't exist, so deployments don't need a shell step. Use the
included configs:

- **Render** — `render.yaml` defines a web service + 1 GB persistent
  disk. New Blueprint → point at this repo → deploy. (Render's
  persistent disks require a paid plan.)
- **Fly.io** — `fly.toml` + `Dockerfile`. See the comments at the top
  of `fly.toml` for the four-command setup. Free tier works.
- **Any host with a Procfile** — `web: node server.js`.

Required env vars in production:

| Var               | Why                                            |
|-------------------|------------------------------------------------|
| `SESSION_SECRET`  | Long random string so logins persist           |
| `CHURCH_DB`       | Path on a persistent disk (e.g. `/data/church.db`) |
| `NODE_ENV`        | Set to `production` for secure cookies         |
| `PORT`            | Usually set by the host                        |

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
