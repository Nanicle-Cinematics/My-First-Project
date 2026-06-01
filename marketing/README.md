# Marketing landing page

Static HTML/CSS site to send prospects to. Self-contained — two files,
no build step. Host on any static host (Netlify, Vercel, Cloudflare
Pages, GitHub Pages, or any web server).

## What you need to customize before going live

Open `index.html` and search for these placeholders:

| Placeholder | Where | What to put |
|---|---|---|
| `YOUR-FORMSPREE-ID` | `<form action="...">` | Sign up at [formspree.io](https://formspree.io), create a form, paste its endpoint here. Free tier handles 50 submissions/month. |
| `233000000000` | WhatsApp links (3 places) | Your WhatsApp number, no `+`, no spaces (e.g. `233244555001`) |
| `hello@example.com` | Footer | Your real contact email |
| Pricing amounts | `#pricing` section | Tune to whatever you settle on |
| Demo URL on header CTAs | None hard-coded | n/a |

Also create `terms.html` and `privacy.html` (or remove those footer
links until you have them).

## How the contact form works

The form posts to [Formspree](https://formspree.io). Once you've signed
up there:

1. Create a new form, name it "Church Manager — demo requests"
2. Set the "Notification email" to yourself
3. Copy the form endpoint (looks like `https://formspree.io/f/xqzpwblr`)
4. Paste it in place of `YOUR-FORMSPREE-ID` in `index.html`

Submissions arrive in your inbox + a Formspree dashboard. Free tier:
50 submissions/month. Paid tier: $10/mo for 1,000 submissions, spam
filter, auto-replies, integrations with Slack / Google Sheets.

## Deploying

### Netlify Drop (zero account needed for first deploy)

1. Open [app.netlify.com/drop](https://app.netlify.com/drop)
2. Drag the entire `marketing/` folder onto the page
3. You'll get a URL like `nervous-newton-12345.netlify.app` instantly
4. Sign up for a free Netlify account to claim the site + add a custom
   domain (free SSL included)

### Vercel (recommended now)

Use Vercel for the public landing/demo page if Netlify is unavailable.
The app itself still runs separately on Fly.io; this is only for the static
marketing site in `marketing/`.

1. Push this repo to GitHub.
2. Sign in to [vercel.com](https://vercel.com) with GitHub.
3. Click **Add New → Project** and import this repo.
4. Set **Root Directory** to `marketing/`.
5. Keep the framework as **Other** / static site.
6. Leave build command empty (or Vercel default) and output directory as `.`.
7. Click **Deploy**.
8. Share the generated `*.vercel.app` URL with churches.

This folder includes `vercel.json` so Vercel serves clean URLs and applies
reasonable cache headers for screenshots and CSS.

After deployment, use two links:

- **Landing/demo page:** your Vercel URL, e.g. `https://church-manager.vercel.app`
- **Live app demo:** `https://church-management-system.fly.dev`

Only share the live app link during a guided demo or after a church requests access.


### Cloudflare Workers & Pages (recommended free option)

This repo includes root Cloudflare config (`wrangler.json` / `wrangler.jsonc`) for Cloudflare Workers builds.
It tells Wrangler to upload `./marketing` as the static assets directory,
so Cloudflare does not try to build the Node/Express app.

If the build log says to specify an assets directory or create a
`wrangler.json` or `wrangler.jsonc` file, make sure your latest commit includes root Cloudflare config with `assets.directory` set to `./marketing`, then retry the deployment.

Recommended Cloudflare settings:

1. Production branch: `main`
2. Root directory: leave blank / repository root
3. Build command: leave blank, or use `exit 0`
4. Deploy command: Cloudflare default / Wrangler
5. Public URL: share the generated `*.workers.dev` or `*.pages.dev` URL

See `docs/CLOUDFLARE_MARKETING_DEPLOY.md` for the full Cloudflare runbook.

### GitHub Pages

1. In your repo settings, enable Pages
2. Build from a branch, pick `claude/church-management-database-pphqQ`,
   folder `/marketing`
3. Site goes live at `<username>.github.io/<repo-name>/`

### Any web server (Apache / nginx / cPanel)

Upload `index.html` and `styles.css` to your `public_html/` or
`htdocs/` folder. That's it — no PHP, no Node, no database needed for
the marketing site.

## Custom domain

Once you've got a domain like `churchmanager.com.gh` or
`mychurchapp.com`:

- **Netlify**: Settings → Domain management → Add custom domain.
- **Vercel**: Project settings → Domains → Add.
- **GitHub Pages**: Repo settings → Pages → Custom domain.

You'll be told what DNS records to add at your domain registrar. Cert
issuance is automatic and free (Let's Encrypt).

## Suggested folder layout once you grow

```
marketing/
├── index.html         (this landing page)
├── styles.css
├── terms.html         (you'll add)
├── privacy.html       (you'll add)
├── case-studies/
│   ├── dunwell.html   (first customer story)
│   └── grace.html
├── images/
│   └── ...screenshots once you have them
└── blog/              (eventually)
```

## Quick wins to add later

1. **Real screenshots** — replace the SVG mockup in the hero with an
   actual dashboard screenshot from your live app. Crop tightly.
2. **Testimonial section** — quote your first three customers (with
   permission). Add their church name and a photo of the pastor.
3. **Open Graph tags** — add `<meta property="og:*">` tags so links
   shared on WhatsApp / Facebook / X get a nice preview.
4. **Google Analytics or Plausible** — to see where traffic comes from.
   Plausible is privacy-friendly and Ghana-cedi affordable.
5. **A demo video** — 60-second screen recording. Drop on YouTube,
   embed in the hero.
