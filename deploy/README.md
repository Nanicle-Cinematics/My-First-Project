# Operator guide — running Church Manager for multiple churches

Each church gets its own Fly.io app + its own SQLite database. Data is
fully isolated per church; one church can never see another's data
because they're literally separate deployments.

## One-time setup (for you, the operator)

1. **Install flyctl** — `curl -L https://fly.io/install.sh | sh`
2. **Sign in** — `flyctl auth login`
3. **Add billing** — Fly requires a credit card on file even for the free
   tier. They won't charge you for small church deployments under their
   free allotment, but the card has to be there.
4. **Make the scripts executable** — `chmod +x deploy/*.sh`

## Onboarding a new church (per church, ~10 min)

```bash
./deploy/new-church.sh
```

The wizard asks for:

- **Slug** — lowercase URL-safe name (e.g. `grace-methodist`). Becomes
  `grace-methodist.fly.dev`.
- **Display name** — what shows in the sidebar (e.g. "Grace Methodist Church").
- **Region** — Fly region code closest to the church. `lhr` (London) is
  the closest free-tier option to Ghana.
- **Memory** — `512mb` is plenty for any single church.
- **Sender ID** — Arkesel SMS sender (max 11 chars, alphanumeric).
- **Arkesel API key** — optional at setup; SMS will be in dry-run mode
  until you set it.
- **Gmail SMTP** — optional. Use a dedicated Gmail account with an App
  Password (not the user's normal password).

The script then:
1. Renders a per-tenant `deploys/<slug>/fly.toml`.
2. Creates the Fly app, the 1 GB persistent volume, and all secrets.
3. Deploys the code.
4. Prints the live URL.

Send the church their URL. They visit it, see the setup page, and
create their first admin account.

## Day-to-day operations

```bash
# List all churches you run
./deploy/manage.sh list

# Per-church operations
./deploy/manage.sh <slug> status      # is it running?
./deploy/manage.sh <slug> logs        # live tail
./deploy/manage.sh <slug> open        # open URL in browser
./deploy/manage.sh <slug> redeploy    # ship latest code
./deploy/manage.sh <slug> backup      # download DB to ./backups/
./deploy/manage.sh <slug> ssh         # shell into the machine

# Adjust capacity
./deploy/manage.sh <slug> scale-up    # always-on (no cold start)
./deploy/manage.sh <slug> scale-down  # cold-start to save money

# Secrets
./deploy/manage.sh <slug> secrets-list
./deploy/manage.sh <slug> set-secret ARKESEL_API_KEY=ak-xxxx

# DR
./deploy/manage.sh <slug> restore backups/<file>.db

# Goodbye
./deploy/manage.sh <slug> destroy
```

## Shipping a code update to ALL churches

```bash
# Push your code change to the repo, then:
for d in deploys/*/; do
  slug=$(basename "$d")
  echo "=== Redeploying $slug ==="
  ./deploy/manage.sh "$slug" redeploy
done
```

A rolling update across 10 churches takes ~25 minutes.

## Backups

Run nightly via cron on your operator machine:

```bash
# crontab -e
0 2 * * * cd /path/to/repo && for d in deploys/*/; do ./deploy/manage.sh "$(basename "$d")" backup; done
```

Keep the `backups/` folder in your operator's home directory, NOT in
the repo. Push them to S3 / Backblaze / Google Drive on a schedule.

## What the church pays for vs. what you pay for

**You pay (per church / month):**
- Fly.io machine + volume: ~$0 if always cold-starting + 1GB volume on the
  free tier (Fly's $5/mo trial credit usually covers it). Past the free
  allotment, ~$1.50/mo per always-on machine.
- Outbound bandwidth: usually free for normal traffic.

**They pay (their own accounts):**
- **Arkesel SMS credits** — per message. Around GH₵ 0.025 each. They
  top up arkesel.com directly; their key, their balance.
- **Gmail SMTP** — free for up to 500 messages/day per Gmail account.
- **Their domain** if they want a custom one (next section).

This separation matters: if a church burns through SMS credits, it's
their bill, not yours. You only carry hosting cost.

## Custom domain per church (optional)

If a church wants `app.gracemethodist.org` instead of
`grace-methodist.fly.dev`:

```bash
flyctl certs create app.gracemethodist.org -a grace-methodist
# Then ask the church to add the DNS records Fly prints.
```

Wait 5-10 min for cert issuance, then also set `PUBLIC_URL`:

```bash
./deploy/manage.sh grace-methodist set-secret PUBLIC_URL=https://app.gracemethodist.org
```

(Charge GH₵ 150-300 one-time for the domain setup.)

## When to graduate to Path 2 (multi-tenancy)

Once you're past ~10 churches, the operational tax of separate
deployments starts to bite. At that point, refactor to a single
multi-tenant app with self-serve signup. Don't do it earlier — the
single-tenant model is simpler and proves demand cheaply.
