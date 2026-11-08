# campaigns

[![CI](https://github.com/openasy/campaigns/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/campaigns/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Campaigns product: every campaign in one calendar with its dates, brief,
budget by channel, goals, owner, tasks and assets; approvals before it goes live; links and QR codes tagged by naming
rules set in a file, so every channel reports under one name; and one page of results: visits and goals from
Analytics, sends, opens and clicks from Messages, and won deals from CRM, each counted for the first and the last
campaign that touched it, against what was spent. Spend is entered by hand, imported from CSV, or read from Google Ads
and Meta. It does not buy or manage ads.

```
campaigns.yaml ──▶ campaigns ──▶ Automation: POST /hooks/{playbook} when a campaign is marked live
                      │ ▲
                      │ └── Audience: POST /api/v1/erasures
                      ├──▶ Analytics: GET /api/v1/report, /api/v1/breakdown  (filter=utmCampaign:is:…)
                      ├──▶ Messages:  GET /api/v1/campaigns                   (slug = utm_campaign)
                      ├──▶ CRM:       GET /api/v1/deals?status=won            (value, contact, source)
                      ├──▶ Audience:  GET /api/v1/people?email=, /people/{id}/events (the touches)
                      └──▶ Google Ads API searchStream, Meta Marketing API insights (spend, read-only)
```

## Campaigns, naming and approvals

A campaign has a name, a start and end day, a brief, its key message, who it is for, an owner, the channels it runs on
with a budget for each, goals, and the members who approve it. Goals are targets for visits, conversions (an Analytics
goal by name), sends, opens, clicks, won deals or revenue.

- **One name.** Its `utm_campaign` is made from its name and start day by `naming.campaign` (`{name}-{year}` by
  default): lowercase ASCII, Turkish letters written plainly (`Sonbahar İndirimi` is `sonbahar-indirimi-2026`), at
  most `naming.max_length`, and matching `naming.pattern` when the file sets one. It can be set by hand within the same
  rules. No two campaigns have the same value (409), and it is fixed once the campaign has links or is live, so one
  campaign never reports under two names.
- **Approval.** A campaign that names approvers cannot be marked live until each of them has approved it; each
  approver decides for themselves (whatever their role), and may ask for changes with a note. An approval is of the
  campaign as it was: a change to its name, dates, brief, message, audience, budget, channels or goals sets every
  decision back to waiting. `approvals.approvers` in the file are named on every new campaign.
- **Status.** Planned, live, ended, cancelled. Marking live is refused while an approval is missing. With
  `automation.launch` in the file, the playbook's webhook is sent `campaign_launched` with the campaign's name,
  `utm`, dates, owner, channels, budget and address, so a launch can start other products' work. A live campaign ends
  by itself the day after its end day.

## Links and QR codes

A link is a destination and a channel. Its `utm_medium` is the channel's `medium` from the file; its `utm_source` is
one the channel allows (`channels.<id>.sources`, else `naming.sources`); `utm_content` and `utm_term` are slugged the
same way as names. The same tagged address is made once. Each link has a QR code, SVG or PNG (1024 pixels), drawn on
the server with [node-qrcode](https://github.com/soldair/node-qrcode).

## Spend

Spend is a day, a channel, an amount in the file's `currency` (minor units, so sums never round), and where it came
from:

- **By hand**, on the campaign.
- **CSV**, a row a day: `day` (or `date`), `campaign` (its `utm_campaign`, id or name), `channel` (id, name or
  medium), `amount` (or `cost`, `spend`) and `note`; comma or semicolon separated, amounts as `1.250,50` or `1,250.50`.
  The same campaign, channel and day replaces what a CSV gave before, so a corrected export can be imported again.
  Check reads every row and changes nothing.
- **Google Ads and Meta**, every `ads.every` for the last `ads.days` days. Each ad campaign's day replaces what was read
  before, and a day the platform no longer reports goes. An ad platform's campaign is ours when the campaign lists it
  under `adNames`, or else when its name carries our `utm_campaign` as a whole (`TR | autumn-2026 | Search` is
  `autumn-2026`'s; the longest match wins, so `autumn-2026-retargeting` is not `autumn-2026`'s). Spend no campaign
  claims is kept and listed; giving it to a campaign adds its name to that campaign's `adNames`. Rows in another
  currency than the file's are left out and reported. Its channel is the one whose `ads` names the platform.

Google Ads is read with `POST /{version}/customers/{id}/googleAds:searchStream` (GAQL over `campaign`, with
`customer.currency_code`, `segments.date`, `metrics.cost_micros`, `clicks` and `impressions`), an access token from the
refresh token, the developer token and, when set, `login-customer-id`. Meta is read with
`GET /{version}/act_{id}?fields=currency` and `GET /{version}/act_{id}/insights?level=campaign&time_increment=1`,
following `paging.next`, with a system user's token that has `ads_read`. LinkedIn and others come in by CSV.

## Results

Results are read every `results.every` and kept, so a page never waits on another product:

- **Analytics.** `GET /api/v1/report` and `GET /api/v1/breakdown?dimension=utmMedium` of `analytics.site`, with
  `filter=utmCampaign:is:<values>`: the campaign's `utm_campaign` and the slugs of the Messages campaigns it claims.
  Visits, visitors, engaged visits and goals, and visits by channel through `utm_medium`. Analytics reports today or
  the last 7, 30 or 90 days, so the shortest that covers the campaign from its start is read; a campaign longer than
  90 days shows its last 90 days, and says so.
- **Messages.** `GET /api/v1/campaigns`: a Messages campaign's links carry its `slug` as `utm_campaign`, so those whose
  slug is the campaign's `utm_campaign` are its own; others are claimed by id under `messagesIds`. Sends, deliveries,
  opens, clicks, bounces and unsubscribes, by channel (`channels.<id>.messages`). Name the Messages campaign so its
  slug is the campaign's `utm_campaign`, and its visits count here too.
- **CRM.** `GET /api/v1/deals?status=won` (of `crm.pipeline` when set): each won deal's value (without KDV), currency,
  close time, company, contact email and source.

A campaign that ended more than `results.settle` days ago is not read again: what was read last stays.

### Attribution: first and last touch, never blended

A **touch** is something that names a campaign and happened to the deal's contact before the deal was won:

1. the lead's own source in CRM: a deal from Live Chat or a form keeps the `utm_campaign` it came with, a touch at the
   deal's creation;
2. from Audience, in the `attribution.window` (90 days) before the deal was won: a visit whose `utm_campaign` names a
   campaign (`visit_started`, from Analytics through Audience), and a click in a message (`message_clicked` from
   Messages, its `campaign` being the Messages slug).

Touches are matched to campaigns when results are shown, by `utm_campaign` or a claimed Messages slug, so a campaign
made later still counts the touches its name was in. Touches that name none of our campaigns are left out. A deal
then counts **in full** for the campaign of its earliest touch (first touch) and in full for the campaign of its latest
touch (last touch). Both are shown side by side, never split or weighted into a model. One campaign can be both. A
deal no campaign touched is counted on the Results page as not attributed. Each touch also has a channel: the channel
whose `medium` is the visit's `utm_medium`, or whose `messages` is the click's channel; a CRM source has none.

Without Audience, the only touch is the CRM source, so first and last are the same. A deal's touches are read when it
is first seen, when its value, close, source or contact changes, and again each read in the week after it was won, while
Audience may still be catching up; at most 200 deals are read from Audience at a time. A deal in another currency than
the file's is listed with its campaigns and counted in neither deals nor revenue.

### ROI

**ROI = (revenue - spend) / spend**, where revenue is the sum of the values of the won deals the campaign is the first
(or the last) touch of, and spend is everything spent on the campaign: by hand, CSV and the ad platforms. Both are
given: `first.roi` and `last.roi`. 0 is break-even, 1 is twice the money back, -1 nothing back; without spend there is
no ROI. Revenue is the deal's value in CRM without KDV, not margin. By channel, the same is shown with each channel's
spend and the deals whose first or last touch was on that channel. Goals for deals and revenue show the last touch,
with the first touch beside it.

The Results page (`GET /api/v1/report?from=&to=`) shows the campaigns that ran in the period with their whole results,
totals by channel, the deals won in the period and those no campaign touched.

## Roles

**Viewers** see everything. **Editors** plan and change campaigns, links, tasks, assets and spend, mark them live, end
and cancel them, and delete planned or cancelled ones. A member a campaign names as an **approver** approves it for
themselves, whatever their role. **Admins** also delete campaigns that ran. Roles are the members' roles under
Members (ADR 0003).

## What other products call

When a person is deleted in Audience, it calls `POST /api/v1/erasures` with a Campaigns token of the admin role. The
won deals kept with one of the emails go (the email is kept only to read the deal's touches); the next read from CRM
brings back what CRM still has. Campaigns answers `{ "status": "done", "deleted": n }`, the same again for the same
reference.

## The settings file

Everything but the records is in [config/campaigns.yaml](./config/campaigns.yaml), read at start and again within a
minute of a change, applied whole or not at all; a file with a mistake leaves the last good version in place. The UI
shows it read-only under Settings.

| Key | Default | |
| --- | --- | --- |
| `currency`, `time_zone` | `TRY`, `Europe/Istanbul` | Money and the days campaigns start and end |
| `channels.<id>` | email, sms, whatsapp, paid-search, paid-social, social, events | `{ name, medium, sources, messages, ads }`; each `medium` is one channel's |
| `naming` | `{name}-{year}`, 40 | `{ campaign, pattern, max_length, sources }` |
| `approvals.approvers` | | Members, by email, every new campaign names |
| `attribution.window` | `90d` | How long before a deal was won a touch counts |
| `results` | `15m`, `14d` | `{ every, settle }` |
| `analytics` | | `{ url, token, site }` |
| `messages`, `audience` | | `{ url, token }` |
| `crm` | | `{ url, token, pipeline }` |
| `automation` | | `{ url, launch: { playbook, token } }` |
| `ads` | `6h`, `30` | `{ every, days, google: { customer_id, login_customer_id, developer_token, client_id, client_secret, refresh_token, api_version }, meta: { ad_account, token, api_version } }` |

Tokens are names of environment variables, never the secret itself. The tokens of Analytics, Messages, CRM and
Audience need only the viewer role.

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/campaigns.yaml
docker compose up -d
docker compose logs campaigns | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CAMPAIGNS_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `CAMPAIGNS_CONFIG` | `/config/campaigns.yaml` | The settings file |
| the variables the file names | | Tokens of the linked products, Google Ads and Meta credentials |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `CAMPAIGNS_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key: sign-in secrets |
| `CAMPAIGNS_DB` | `/data/campaigns.db` | SQLite file (WAL), on the `/data` volume |
| `CAMPAIGNS_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `CAMPAIGNS_HEADLESS` | `false` | `true` serves no team UI; the API stays |
| `CAMPAIGNS_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in for the team, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Metrics
include campaigns by status, unclaimed spend rows, won deals read, and which links failed their last read. The API
reference is at `/api/docs/`.

## Develop

```bash
npm install
npm test           # the file and naming rules, approvals, links and QR codes, spend by CSV, Google Ads and Meta
                   # against fakes, results and first and last touch against fakes of Analytics, Messages, CRM and
                   # Audience, the Automation webhook, and every API response against openapi.json
npm run openapi    # writes openapi.json after an API change; a test fails while it is out of date
npm run dev        # the UI, with the API on :8080
```

What is tested against fakes only: Analytics, Messages, CRM, Audience and Automation are fakes in `server/fakes.ts`
that answer in the shapes of their `openapi.json`; Google's OAuth token endpoint, the Google Ads API searchStream and
Meta's Graph API answer in the shapes their documentation gives. The real Google Ads and Meta APIs, their API
versions (`api_version`, `v22` and `v23.0` by default), developer token approval, rate limits and account currencies
are not tested here.

The team UI follows the Campaigns screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only Settings
page is rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a published
`@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
