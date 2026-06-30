# Monitoring And Alerts

The app exposes:

- `/healthz`: process health.
- `/readyz`: database readiness.
- `/operations`: owner command center.
- `/operations/health-report.txt`: owner downloadable health report.
- `/operations/alerts.json`: owner machine-readable alert summary.

## Alert Routing

Configure at least one:

- `ALERT_WEBHOOK_URL`
- `ALERT_EMAIL`

The current implementation reports whether routing is configured and exposes alerts in `/operations/alerts.json`. A production scheduler or external monitor should poll the health and alert endpoints.

## Recommended External Checks

- Poll `/healthz` every minute.
- Poll `/readyz` every minute.
- Poll `/operations/alerts.json` with an authenticated owner session or future service token.
- Alert if health/readiness fail twice.
- Alert if off-site backup is not configured.
- Alert if recent server errors are present.
- Alert if posted journals become unbalanced.

## Launch Gate

Do not broadly sell until:

- Off-site backups are configured.
- Alert routing is configured.
- Monthly restore drill has passed.
- User acceptance test plan has been completed by at least one pilot church.
