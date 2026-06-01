# Rollback Pin (v1.2.0)

Use this document to record the exact production rollback target for the current release.

## Release

- Version: `v1.2.0`
- Date: `2026-05-28`
- Git tag: `v1.2.0`

## Pin these before/after deploy

- App: `church-management-system`
- Machine id: `<fill-after-deploy>`
- Previous image ref: `<fill-after-deploy>`
- New image ref: `<fill-after-deploy>`

Capture with:

```bash
flyctl machine list -a church-management-system --json
```

## Rollback command

```bash
flyctl machine update <machine-id> -a church-management-system --image <previous-image-ref>
```

## Validation after rollback

```bash
curl -i https://church-management-system.fly.dev/healthz
curl -i https://church-management-system.fly.dev/readyz
flyctl logs -a church-management-system --no-tail | tail -n 50
```
