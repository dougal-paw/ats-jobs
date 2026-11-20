#!/usr/bin/env node
// Fetch every open job from companies on Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee or Personio, normalised to one schema.
// Usage: node cli.js [options] <company>...   (company = careers-page URL, "ats:slug" or bare slug)
import { parseCompanyEntry, fetchCompany, processCompanyJobs, mapLimit } from './core.js';

const args = process.argv.slice(2);
const opts = { includeDescription: false };
const companies = [];
let format = 'jsonl';
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => args[++i];
    if (a === '--keyword' || a === '-k') (opts.keywords ??= []).push(val());
    else if (a === '--location' || a === '-l') (opts.locations ??= []).push(val());
    else if (a === '--department' || a === '-d') (opts.departments ??= []).push(val());
    else if (a === '--remote') opts.remoteOnly = true;
    else if (a === '--since-days') opts.postedSinceDays = Number(val());
    else if (a === '--max') opts.maxJobsPerCompany = Number(val());
    else if (a === '--descriptions') opts.includeDescription = true;
    else if (a === '--json') format = 'json';
    else if (a === '--help' || a === '-h') companies.length = 0, i = args.length, opts.help = true;
    else companies.push(a);
}
if (opts.help || !companies.length) {
    console.error(`Usage: node cli.js [options] <company>...

  company           https://boards.greenhouse.io/airbnb, lever:zoox, ashby:ramp, smartrecruiters:Equinox,
                    recruitee:bunq, personio:clark, or a bare slug (auto-detect)
  -k, --keyword     match title/department (repeatable)
  -l, --location    match location text; "remote" also matches remote jobs (repeatable)
  -d, --department  match department or team (repeatable)
      --remote      remote jobs only
      --since-days  only jobs published in the last N days
      --max         at most N jobs per company
      --descriptions  include plain-text descriptions (contact details redacted)
      --json        print one JSON array instead of JSON Lines`);
    process.exit(opts.help ? 0 : 1);
}

const all = [];
let failed = 0;
await mapLimit(companies, 3, async (entry) => {
    try {
        const res = await fetchCompany(parseCompanyEntry(entry), { includeDescription: opts.includeDescription, maxJobsPerCompany: opts.maxJobsPerCompany });
        const { items } = processCompanyJobs(res.jobs, res.ats, res.slug, opts);
        if (format === 'jsonl') for (const j of items) process.stdout.write(JSON.stringify(j) + '\n');
        else all.push(...items);
        console.error(`${entry}: ${res.ats}/${res.slug}, ${res.jobs.length} open, ${items.length} matched`);
    } catch (err) {
        failed++;
        console.error(`${entry}: ${err.message}`);
    }
});
if (format === 'json') process.stdout.write(JSON.stringify(all, null, 2) + '\n');
process.exitCode = failed ? 2 : 0;
