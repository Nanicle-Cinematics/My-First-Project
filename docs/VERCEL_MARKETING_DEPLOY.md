# Vercel Marketing Deployment

Use this for the public Church Manager landing/demo page.

## What gets deployed

Deploy only the static marketing site:

- Root directory: `marketing/`
- Entry page: `marketing/index.html`
- Vercel config: `marketing/vercel.json`

The production app remains on Fly.io at `https://church-management-system.fly.dev`.

## GitHub import steps

1. Push the latest repo to GitHub.
2. Open Vercel and choose **Add New → Project**.
3. Import the GitHub repo.
4. Set **Root Directory** to `marketing/`.
5. Use framework preset **Other** / static site.
6. Leave build command empty and output directory as `.`.
7. Deploy.

## After deploy

- Open the generated `*.vercel.app` URL.
- Confirm the landing page loads.
- Submit a test demo request if you want to verify Formspree.
- Confirm WhatsApp link opens correctly.

## Link strategy

Share the Vercel URL publicly:

```text
https://your-project.vercel.app
```

Keep the Fly app URL for guided demos and customer access:

```text
https://church-management-system.fly.dev
```

## Custom domain later

When ready, add a domain in Vercel project settings and follow the DNS instructions Vercel provides.
