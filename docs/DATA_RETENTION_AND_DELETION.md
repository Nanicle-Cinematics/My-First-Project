# Data Retention and Deletion Policy

Effective: 2026-07-04. Owner: Church Manager platform operator.

## Tenant off-boarding

1. “Delete church” immediately blocks all tenant access and starts a 30-day recovery period.
2. During recovery, the platform owner may restore the church after verifying the requestor.
3. Before permanent erasure, create and verify an encrypted tenant export, confirm there is no legal or payment hold, and obtain written authorization from the church owner.
4. After 30 days, permanently erase tenant data during a documented maintenance operation. Keep only the minimum non-content audit evidence required to prove the deletion.
5. Encrypted backup copies expire after 30 days; deletion therefore completes across normal backup rotation no later than 60 days after the initial request.

## Operational retention

- Encrypted database backups: 30 days.
- Security audit logs: 365 days.
- Application error logs: 90 days.
- Email delivery logs: 180 days.
- Unused password-reset tokens: 24 hours after expiry.
- Used/expired email-verification tokens: 7 days.
- Financial records: retained for the legally required period; a legal hold overrides automated deletion.

## Controls

- Permanent erasure is never a one-click browser action.
- The production database must never be used as a restore-drill target.
- Every deletion, restoration, export, backup and restore drill must be attributable to an operator.
- Review this policy annually and whenever applicable Ghanaian law or contractual requirements change.
