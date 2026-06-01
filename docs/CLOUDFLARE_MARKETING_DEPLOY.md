# Cloudflare Marketing Deployment

Use this when Cloudflare Workers & Pages is connected to GitHub for the public Church Manager landing/demo page.

## What Cloudflare should deploy

Deploy only the static marketing site:

- Assets directory: `./marketing`
- Entry page: `marketing/index.html`
- Cloudflare config: `wrangler.json` and `wrangler.jsonc`

The production app remains on Fly.io at `https://church-management-system.fly.dev`.

## Why `wrangler.json` exists

Cloudflare Workers builds use Wrangler. When the build log says to specify an assets directory or create a `wrangler.json`/`wrangler.jsonc` file, Wrangler needs to know which folder contains the static files to upload.

This repo keeps Cloudflare config at the repo root (`wrangler.json` plus `wrangler.jsonc`) so Cloudflare can deploy the `marketing/` folder directly without trying to build the Node/Express app. If GitHub shows `wrangler.jsonc`, that file is valid for Wrangler; just make sure it contains the `assets.directory` setting for `./marketing`.

## Cloudflare dashboard settings

In **Workers & Pages → mychurchmanager → Settings → Builds and deployments**, use:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | leave blank, or use `exit 0` |
| Root directory | leave blank / repository root |
| Deploy command | Cloudflare default / Wrangler |

Do not point Cloudflare at the Fly app. Cloudflare is only hosting the public landing page.

## After deploy

- Open the generated `*.workers.dev` or `*.pages.dev` URL.
- Confirm the landing page loads.
- Confirm screenshots and CSS load.
- Confirm the WhatsApp link opens correctly.
- Submit a test demo request if Formspree has been configured.

## Link strategy

Share the Cloudflare URL publicly:

```text
https://mychurchmanager.<cloudflare-domain>
```

Keep the Fly app URL for guided demos and customer access:

```text
https://church-management-system.fly.dev
```
