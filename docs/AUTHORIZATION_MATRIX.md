# Authorization Matrix

Phase 2 access model for operational readiness.

| Area | Admin | Editor | Viewer |
| --- | --- | --- | --- |
| Dashboard | Read | Read | Read |
| Members | Read/write | Read/write | Read |
| Attendance | Read/write | Read/write | Read |
| Finance | Read/write | Read/write | Read |
| Events | Read/write | Read/write | Read |
| Communications | Read/write | Read/write | Read |
| Inventory | Read/write | Read/write | Read |
| Preaching plan | Read/write | Read/write | Read |
| Sacraments | Read | Read | Read |
| Reports and CSV exports | Read | Read | Read |
| Profile password change | Own account | Own account | Own account |
| Users and roles | Read/write | Blocked | Blocked |
| Security audit log | Read | Blocked | Blocked |
| Backups and restore | Read/write | Blocked | Blocked |
| Error log | Read/write | Blocked | Blocked |
| Settings and integrations | Read/write | Blocked | Blocked |

Notes:

- `admin` is the owner role. It can access owner-only operations such as users, backups, settings, errors, and security audit.
- `editor` can create and edit church records but cannot manage accounts, backups, settings, errors, or audit data.
- `viewer` is read-only for normal church records.
- Only the main administrator username `dunwelladmin` can add/delete user accounts and reset passwords.
- Security-sensitive actions are recorded in `security_audit_log` and reviewed at `/security/audit`.
