# User Acceptance Test Plan

Run this checklist with real church users before selling broadly.

## Roles To Test

- Administrator.
- Secretary or editor.
- Treasurer or steward.
- Cashier.
- Auditor.
- Viewer.

## Desktop And Mobile Browsers

- Chrome desktop.
- Safari desktop if available.
- Android Chrome.
- iPhone Safari if available.

## Core Tasks

- Sign in and sign out.
- Reset or change password.
- Add, edit and search members.
- Import a small member CSV with one rejected row.
- Upload and view a member photo.
- Record a service offering.
- Record tithes, generic income, expenses and pledges.
- Print a receipt and voucher.
- Export finance and member reports.
- Record attendance.
- Create an event and RSVP.
- Send a dry-run broadcast.
- Create and verify a backup.
- Review Operations, Security Audit and Error Log.

## Destructive Task Test

Use a non-production pilot database only:

- Create test inventory data.
- Run Inventory `Delete all`.
- Confirm a backup was created first.
- Confirm the deleted data is gone.

## Sign-Off

Record:

- Church name.
- Test date.
- Users who tested.
- Browser/device.
- Issues found.
- Whether the church is ready for live data.
