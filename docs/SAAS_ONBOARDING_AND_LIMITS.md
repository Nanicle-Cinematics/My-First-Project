# SaaS Onboarding And Plan Limits

## Plan Limits

| Plan | Members | Users | Branches | Support |
|---|---:|---:|---:|---|
| Starter | 150 | 3 | 1 | Standard support |
| Pro | 800 | 10 | 1 | Priority support |
| Enterprise | 5000 | 50 | 10 | Dedicated onboarding |

The owner-only `/tenant` page shows current usage against these limits.

## Onboarding Flow

1. Receive trial signup.
2. Confirm church name, contact person, email, phone and selected plan.
3. Provision or verify the private church workspace.
4. Activate the first administrator.
5. Import members from the agreed CSV template.
6. Create staff users and assign roles.
7. Configure finance funds/categories and receipt numbering expectations.
8. Configure SMS/email only after test sends succeed.
9. Create and verify the first backup.
10. Run the user acceptance checklist in `docs/USER_ACCEPTANCE_TEST_PLAN.md`.

## Tenant Admin Checklist

- Check `/tenant` for plan and usage.
- Check `/operations` for backup, alert and provider readiness.
- Check `/security/audit` after creating users.
- Check `/backups` after imports or delete-all actions.
- Record the customer's support contact and billing contact outside the app until billing automation is connected.
