# Running the relay in production

Only one piece of Stead is a server. The desktop app, the agent and the
knowledge base run on each person's own machine, and the relay is a switchboard
that connects them — it never sees a knowledge base and never calls a model.
So "deploying Stead" means deploying `@ai-coworker/server` and nothing else.
Everyone still installs the desktop app locally and points it at the URL.

```
  your laptop                     Azure                      teammate's laptop
  ┌──────────────┐                                            ┌──────────────┐
  │ desktop app  │                                            │ desktop app  │
  │ agent + LLM  │──── wss ────▶ ┌──────────────┐ ◀─── wss ───│ agent + LLM  │
  │ knowledge KB │               │    relay     │             │ knowledge KB │
  └──────────────┘               │  /data/*.json│             └──────────────┘
   META_API_KEY                  └──────────────┘              META_API_KEY
   lives here                     no model key                 lives here
```

---

## Environment variables

### The relay — the only thing you deploy

| Variable | Default | What to set in production |
|---|---|---|
| `PORT` | `8787` | Leave it. App Service sets this itself (8080) and terminates TLS in front; Container Apps maps 443 → 8787. `AI_COWORKER_PORT` is an alias. |
| `HOST` | `0.0.0.0` | Leave it. |
| `AI_COWORKER_REQUIRE_AUTH` | unset → **`optional`** | **Set to `1`.** Unset, a socket that presents no token is admitted under whatever address it claims — fine on your laptop, an open door on a public URL. |
| `AI_COWORKER_RELAY_NAME` | `Stead` | Your team's name. Appears in confirmation emails and as the relay's own identity. |
| `AI_COWORKER_WORKSPACE` | `Home` | Name of the workspace created on first boot. Only read when there is no state yet. |
| `AI_COWORKER_ACCOUNT_STATE` | `./.relay-accounts.json` | Path on the mounted volume. **Emails, password hashes and live session tokens.** |
| `AI_COWORKER_WORKSPACE_STATE` | `./.relay-workspaces.json` | Path on the mounted volume. Workspaces, channels, membership, messages. |
| `AI_COWORKER_RELAY_STATE` | `./.relay-state.json` | Path on the mounted volume. Booked meetings, so a restart doesn't drop the calendar. |
| `AI_COWORKER_TURN_TIMEOUT_MS` | `240000` | Only if agents are timing out mid-meeting on a slow model. |
| `ACS_CONNECTION_STRING` | unset | Azure Communication Services, `endpoint=…;accesskey=…`. **Set both this and the sender, or codes come back in the HTTP response.** |
| `ACS_SENDER_ADDRESS` | unset | The verified sender, e.g. `DoNotReply@<guid>.azurecomm.net`. |

The relay needs **no model credentials**. If you find yourself putting
`META_API_KEY` on the server, something has gone wrong.

### Each person's machine — desktop app and CLI agent

Read from `.env` next to the app, or the real environment.

| Variable | Default | Notes |
|---|---|---|
| `META_API_KEY` | — | The agent's brain. `LLAMA_API_KEY` is accepted too. Without one, agents fall back to a scripted offline brain — they run, but they don't think. |
| `META_MODEL` | `muse-spark-1.2` | |
| `META_API_BASE` | `https://api.meta.ai/v1` | Only for a proxy or a private gateway. |
| `META_MIN_INTERVAL_MS` | `0` | Minimum gap between model calls. Raise it on a rate-limited key or meetings will hit limits. |
| `AI_COWORKER_OFFLINE` | unset | `1` forces the offline brain, ignoring any key. |
| `AI_COWORKER_RELAY` | `ws://localhost:8787` | Default relay for the CLI agent. In the desktop app this is a field on the sign-in screen — `wss://<your-app>.azurewebsites.net`. |

---

## Deploy

Two scripts, same relay, different hosts. Both are idempotent — run again to
ship a new build to the same URL with the accounts intact — and both put
everything in one resource group, so `az group delete -n stead-rg --yes`
removes all of it.

### App Service B1 — what's running today, ~$12/mo

```bash
az login
./scripts/deploy-azure-appservice.sh
```

Linux B1 at $0.0170/hour, and that is the entire bill: `/home` is persistent, so
the state files need no storage account, and a zip deploy needs no container
registry. TLS and `wss` on `*.azurewebsites.net` are free. Always On is set
because the relay arms an in-process timer per booked meeting — a plan that
sleeps misses them.

Knobs: `STEAD_RG`, `STEAD_LOCATION`, `STEAD_PLAN`, `STEAD_APP`,
`AI_COWORKER_RELAY_NAME`, `AI_COWORKER_WORKSPACE`.

One wrinkle worth knowing if you edit the staging step: `npm install` prunes
anything it thinks is extraneous, so `@ai-coworker/shared` is copied into
`node_modules` *after* the install, not before. A `file:` dependency would leave
a symlink instead, and symlinks do not survive the zip.

### Container Apps — ~$19/mo

```bash
./scripts/deploy-azure.sh
```

Builds the image in Azure Container Registry (no local Docker push), mounts an
Azure Files share at `/data`, and pins to exactly one replica. Costs about $7/mo
more — $5 of that is ACR Basic — and buys a cleaner container story and a
shorter path to scaling out later.

### Then, on each machine

Put `wss://<fqdn>` in the relay field on the desktop app's sign-in screen.

---

## Mail, and why it decides whether the relay is safe to expose

With no transport configured the relay falls back to `LogMailer`, which prints
the confirmation code instead of sending it — and because the mailer is that
one, `POST /auth/start` also returns the code in its own reply (`devCode`) so
the app can fill it in during a local demo. On a public URL that is an open
door: anyone who can reach the relay asks for a code for any address and reads
it straight back. `AI_COWORKER_REQUIRE_AUTH=1` does not close it, because it is
the sign-up path itself.

Setting `ACS_CONNECTION_STRING` and `ACS_SENDER_ADDRESS` swaps in `AcsMailer`,
and `startEmail` then withholds the code — the only way to learn it is to own
the mailbox. Check which one is live without reading any logs:

```bash
curl -s https://<fqdn>/auth/config     # codesInResponse: false  <- real mail
```

Provisioning the Azure side, all free to create and billed per message (about
$0.00025 each, so a rounding error for a team):

```bash
az communication email create --name stead-email -g stead-rg \
  --location global --data-location UnitedStates
az communication email domain create --domain-name AzureManagedDomain \
  --email-service-name stead-email -g stead-rg --location global \
  --domain-management AzureManaged
az communication create --name stead-comms -g stead-rg --location global \
  --data-location UnitedStates --linked-domains "<domain resource id>"
```

The Azure-managed domain needs no DNS and is rate limited, which suits a team
and not a mailing list. Sending from your own domain means creating the domain
with `--domain-management CustomerManaged` and adding the SPF and DKIM records
it asks for.

Delivery is asynchronous, so a mistyped address still answers `sent: true` and
bounces quietly later. That is deliberate — the endpoint must never reveal
whether an address is registered, or it becomes a way to enumerate the team.

## One replica, and that is a design constraint

Workspaces, rooms, live sockets and meeting state live in memory, flushed to
three JSON files; nothing is shared between processes. Two replicas would be two relays that disagree. Do not
turn on autoscale. For a team this is fine — the relay routes messages, it does
not do the thinking. Scaling out would mean shared state (Redis or Postgres for
the hub, a pub/sub fan-out for sockets) first.

Also: back up the state directory. Losing `relay-accounts.json` locks everybody out.
