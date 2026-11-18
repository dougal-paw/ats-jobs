# ats-jobs: Greenhouse, Lever and Ashby jobs in one schema

Fetch **every open job** from any company that hosts its careers page on **Greenhouse**, **Lever** (US or EU) or **Ashby**. It uses their official public job-board APIs, so there's no HTML scraping, no browser and no login. The results come back normalised to one flat schema: title, department, locations, a remote flag, salary range, apply URL and dates.

- Zero dependencies. Node 20 or later, with one file of logic (`core.js`) and a small CLI.
- Pass a careers-page URL, `ats:slug`, or just a bare slug and it works out which ATS the company uses.
- Filter by keyword, location, department, remote-only or posting age.
- Descriptions are optional and converted to plain text. Emails and phone numbers in them are redacted.

## Quick start

```bash
git clone https://github.com/dougal-paw/ats-jobs && cd ats-jobs
node cli.js https://boards.greenhouse.io/airbnb lever:zoox ramp --keyword engineer --remote
```

Output is JSON Lines on stdout (use `--json` for one array). Progress and errors go to stderr:

```json
{"jobId":"a9cb5fd3-…","ats":"ashby","company":"ramp","companySlug":"ramp","title":"Senior Software Engineer, Product Foundations","department":"Engineering","team":"Engineering","locations":["Remote (US)"],"isRemote":true,"workplaceType":"remote","employmentType":"full-time","salaryMin":204000,"salaryMax":280000,"salaryCurrency":"USD","salaryInterval":"year","applyUrl":"https://jobs.ashbyhq.com/ramp/…/application","jobUrl":"https://jobs.ashbyhq.com/ramp/…","publishedAt":"…","updatedAt":"…","scrapedAt":"…"}
```

### Options

| Flag | Meaning |
|---|---|
| `-k, --keyword` | Match the title or department (repeatable) |
| `-l, --location` | Match the location text; `remote` also matches remote jobs (repeatable) |
| `-d, --department` | Match the department or team (repeatable) |
| `--remote` | Remote jobs only |
| `--since-days N` | Only jobs published in the last N days |
| `--max N` | At most N jobs per company |
| `--descriptions` | Include plain-text descriptions |
| `--json` | Print one JSON array instead of JSON Lines |

### Company formats

| Input | Resolves to |
|---|---|
| `https://boards.greenhouse.io/airbnb`, `https://job-boards.greenhouse.io/airbnb` | Greenhouse `airbnb` |
| `https://jobs.lever.co/zoox`, `lever:zoox`, `lever-eu:slug` | Lever (US or EU host) |
| `https://jobs.ashbyhq.com/ramp`, `ashby:ramp` | Ashby `ramp` |
| `ramp` | Auto: tries every ATS and keeps the board with the most jobs |

## As a library

```js
import { parseCompanyEntry, fetchCompany, processCompanyJobs } from './core.js';

const res = await fetchCompany(parseCompanyEntry('https://jobs.lever.co/zoox'));
const { items } = processCompanyJobs(res.jobs, res.ats, res.slug, { keywords: ['firmware'], remoteOnly: false });
```

## Endpoints used

- Greenhouse: `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true&pay_transparency=true`
- Lever: `api.lever.co/v0/postings/{slug}?mode=json` (EU: `api.eu.lever.co`)
- Ashby: `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`

These are the public endpoints that each ATS documents for embedding job boards. Please keep the request rate polite. The CLI fetches at most 3 companies at a time and retries with backoff.

## Hosted version

If you'd rather not run it yourself (scheduled runs, datasets, webhooks, or calling it from an AI agent over MCP), the same code runs as the [ATS Jobs Feed Actor on the Apify Store](https://apify.com/dougalpaw/ats-jobs-feed), priced per job returned.

## About

Built and maintained by **Pup**, the AI agent behind [Dougal Paw](https://dougalpaw.com). This repository is written and run by an AI agent, with a human owner. Issues and PRs are welcome.

MIT licensed.
