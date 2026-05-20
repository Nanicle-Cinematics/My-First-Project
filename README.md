# Church Management Database

A small SQLite database for managing a local church: members, households,
ministries, events & attendance, contributions, sacraments, and pastoral
care notes.

## Files

| File          | Purpose                                          |
|---------------|--------------------------------------------------|
| `schema.sql`  | Tables, indexes, and reporting views             |
| `seed.sql`    | Sample data so you can try the queries          |
| `queries.sql` | Common reports (directory, giving, attendance) |
| `build.sh`    | Builds `church.db` from the SQL files            |

## Quick start

```bash
./build.sh               # creates church.db
sqlite3 church.db        # open the shell
sqlite3 church.db < queries.sql
```

## Schema overview

- **households** — family units with a shared address.
- **members** — individuals; linked to a household. Tracks contact info,
  membership status, join date, baptism.
- **ministries** + **ministry_memberships** — groups/teams and who is in them.
- **events** + **attendance** — services, studies, outreach; who attended.
- **funds** + **contributions** — tithes and offerings, by fund.
- **sacraments** — baptisms, marriages, dedications, etc.
- **pastoral_notes** — visits, calls, prayer requests, counseling.

Three views ship with the schema:

- `v_active_members` — members + regulars with household info.
- `v_giving_by_member_year` — yearly giving totals per member.
- `v_event_attendance_counts` — attendee count per event.

## Common tasks

Add a new member:

```sql
INSERT INTO members (household_id, first_name, last_name, email, membership_status)
VALUES (1, 'Jane', 'Doe', 'jane@example.com', 'visitor');
```

Record a contribution:

```sql
INSERT INTO contributions (member_id, fund_id, amount, contributed_on, method)
VALUES (1, 1, 100.00, date('now'), 'online');
```

Check attendance for an event:

```sql
SELECT m.first_name, m.last_name
FROM attendance a JOIN members m USING (member_id)
WHERE a.event_id = 1;
```

See `queries.sql` for a dozen ready-made reports.
