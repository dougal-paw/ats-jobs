// Core logic for ATS Jobs Feed. No Apify SDK here, so it can be tested with plain Node.

export const USER_AGENT = 'ats-jobs/0.1 (+https://github.com/dougal-paw/ats-jobs)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NotFoundError extends Error {}

/** GET JSON with retries on 429/5xx/network errors. Throws NotFoundError on 404. */
export async function fetchJson(url, { retries = 3, timeoutMs = 30000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status === 404) throw new NotFoundError(`Not found (404): ${url}`);
            if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(`HTTP ${res.status} from ${url}`);
                const ra = Number(res.headers.get('retry-after'));
                if (ra > 0 && ra < 60) await sleep(ra * 1000);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
            const body = await res.json();
            // Lever answers unknown sites with {ok:false,error:"Document not found"} and a 404, but be defensive.
            if (body && body.ok === false && /not found/i.test(body.error || '')) throw new NotFoundError(`Not found: ${url}`);
            return body;
        } catch (err) {
            if (err instanceof NotFoundError) throw err;
            if (err instanceof Error && /^HTTP 4\d\d/.test(err.message)) throw err;
            lastErr = err;
        }
    }
    throw lastErr;
}

// ---------- Company input parsing ----------

const ATS_ALIASES = {
    greenhouse: 'greenhouse',
    gh: 'greenhouse',
    lever: 'lever',
    'lever-eu': 'lever-eu',
    levereu: 'lever-eu',
    ashby: 'ashby',
    ashbyhq: 'ashby',
    auto: 'auto',
};

function cleanSlug(s) {
    return decodeURIComponent(String(s || '').trim()).replace(/^\/+|\/+$/g, '').split(/[/?#]/)[0].trim();
}

/** Parse a careers-page or API URL into { ats, slug }. Returns null if the host is not supported. */
export function parseCareersUrl(raw) {
    let u;
    try {
        u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        return null;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (/(^|\.)greenhouse\.io$/.test(host)) {
        const forParam = u.searchParams.get('for');
        if (forParam) return { ats: 'greenhouse', slug: cleanSlug(forParam) };
        if (host.startsWith('boards-api.')) {
            const i = parts.indexOf('boards');
            if (i >= 0 && parts[i + 1]) return { ats: 'greenhouse', slug: cleanSlug(parts[i + 1]) };
            return null;
        }
        if (parts[0] && parts[0] !== 'embed') return { ats: 'greenhouse', slug: cleanSlug(parts[0]) };
        return null;
    }
    if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
        if (!parts[0]) return null;
        return { ats: host === 'jobs.eu.lever.co' ? 'lever-eu' : 'lever', slug: cleanSlug(parts[0]) };
    }
    if (host === 'api.lever.co' || host === 'api.eu.lever.co') {
        const i = parts.indexOf('postings');
        if (i >= 0 && parts[i + 1]) return { ats: host === 'api.eu.lever.co' ? 'lever-eu' : 'lever', slug: cleanSlug(parts[i + 1]) };
        return null;
    }
    if (host === 'jobs.ashbyhq.com') {
        if (!parts[0]) return null;
        return { ats: 'ashby', slug: cleanSlug(parts[0]) };
    }
    if (host === 'api.ashbyhq.com') {
        const i = parts.indexOf('job-board');
        if (i >= 0 && parts[i + 1]) return { ats: 'ashby', slug: cleanSlug(parts[i + 1]) };
        return null;
    }
    return null;
}

const looksLikeUrl = (s) => /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+\//.test(s) || /\.(io|co|com)(\/|$)/i.test(s);

/**
 * Accepts: "https://boards.greenhouse.io/airbnb", "lever:zoox", "lever-eu:quantinuum", "ramp" (auto),
 * or { ats, slug } / { ats, url } objects. Returns { ats, slug, label } or throws with a helpful message.
 */
export function parseCompanyEntry(entry) {
    if (entry && typeof entry === 'object') {
        const ats = ATS_ALIASES[String(entry.ats || 'auto').toLowerCase().trim()];
        if (!ats) throw new Error(`Unknown ATS "${entry.ats}". Use greenhouse, lever, lever-eu, ashby or auto.`);
        const val = String(entry.slug || entry.url || '').trim();
        if (!val) throw new Error('Company entry has no "slug" or "url".');
        if (looksLikeUrl(val)) {
            const parsed = parseCareersUrl(val);
            if (!parsed) throw new Error(`Unsupported careers-page URL: ${val}`);
            if (ats !== 'auto' && ats.replace('-eu', '') !== parsed.ats.replace('-eu', '')) {
                throw new Error(`URL ${val} is a ${parsed.ats} URL but ats was set to ${ats}.`);
            }
            return { ...parsed, label: val };
        }
        return { ats, slug: cleanSlug(val), label: `${ats}:${val}` };
    }
    const s = String(entry ?? '').trim();
    if (!s) throw new Error('Empty company entry.');
    const m = s.match(/^([a-z-]+):(?!\/\/)(.+)$/i);
    if (m && ATS_ALIASES[m[1].toLowerCase()]) {
        return { ats: ATS_ALIASES[m[1].toLowerCase()], slug: cleanSlug(m[2]), label: s };
    }
    if (looksLikeUrl(s)) {
        const parsed = parseCareersUrl(s);
        if (!parsed) throw new Error(`Unsupported careers-page URL: ${s} (supported: Greenhouse, Lever, Ashby board URLs).`);
        return { ...parsed, label: s };
    }
    return { ats: 'auto', slug: cleanSlug(s), label: s };
}

// ---------- Fetchers ----------

const fetchers = {
    async greenhouse(slug) {
        const data = await fetchJson(
            `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true&pay_transparency=true`,
        );
        return Array.isArray(data?.jobs) ? data.jobs : [];
    },
    async lever(slug) {
        const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
        return Array.isArray(data) ? data : [];
    },
    async 'lever-eu'(slug) {
        const data = await fetchJson(`https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
        return Array.isArray(data) ? data : [];
    },
    async ashby(slug) {
        const data = await fetchJson(
            `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
        );
        return Array.isArray(data?.jobs) ? data.jobs.filter((j) => j.isListed !== false) : [];
    },
};

/**
 * Resolve a company to an ATS and fetch its raw postings.
 * "lever" tries the global host and then the EU host. "auto" tries Greenhouse, Lever (global, EU) and Ashby,
 * and picks the first board that has jobs (or the first board that exists, if all are empty).
 */
export async function fetchCompany({ ats, slug }) {
    const order = ats === 'auto'
        ? ['greenhouse', 'lever', 'lever-eu', 'ashby']
        : ats === 'lever' ? ['lever', 'lever-eu'] : [ats];
    let firstEmpty = null;
    const errors = [];
    const found = [];
    for (const candidate of order) {
        try {
            const jobs = await fetchers[candidate](slug);
            if (jobs.length > 0) {
                // Explicit ATS: first board with jobs wins. Auto: the same slug can exist on several ATSs
                // (often an old or unrelated board), so check them all and keep the one with the most jobs.
                if (ats !== 'auto') return { ats: candidate, slug, jobs };
                found.push({ ats: candidate, slug, jobs });
            } else if (!firstEmpty) firstEmpty = { ats: candidate, slug, jobs };
        } catch (err) {
            if (!(err instanceof NotFoundError)) errors.push(`${candidate}: ${err.message}`);
        }
    }
    if (found.length) {
        found.sort((a, b) => b.jobs.length - a.jobs.length);
        const best = found[0];
        if (found.length > 1) {
            best.note = `"${slug}" exists on several ATSs (${found.map((f) => `${f.ats}: ${f.jobs.length} jobs`).join(', ')}); `
                + `using ${best.ats}. Use a careers-page URL or an "ats:slug" prefix to choose another.`;
        }
        return best;
    }
    if (firstEmpty) return firstEmpty;
    if (errors.length) throw new Error(`Could not fetch "${slug}": ${errors.join('; ')}`);
    throw new NotFoundError(`No ${ats === 'auto' ? 'Greenhouse, Lever or Ashby' : ats} job board found for "${slug}".`);
}

// ---------- Text helpers ----------

const NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
    euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', eacute: 'é', egrave: 'è', agrave: 'à',
    ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', zwj: '', zwnj: '', shy: '',
};

export function decodeEntities(s) {
    return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            try { return String.fromCodePoint(code); } catch { return m; }
        }
        const v = NAMED_ENTITIES[e.toLowerCase()];
        return v === undefined ? m : v;
    });
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Candidate phone numbers: digit groups separated by single spaces, dots or dashes, optional +country and (area).
const PHONE_RE = /(?<![\w$€£¥.,/:#-])(\+\s?)?(\(\d{1,5}\)[ .-]?)?\d{1,5}(?:[ . -]\(?\d{1,5}\)?){1,6}(?![\w%$€£¥]|[.,]\d)/g;

function looksLikePhone(match) {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) return false;
    if (/^\s*\+/.test(match) || /\(/.test(match)) return true;
    const groups = match.trim().split(/[ . -]+/);
    // Needs at least 3 groups (e.g. 020 7946 0958, 555-123-4567) to avoid catching IDs or big numbers.
    return groups.length >= 3 || digits.length >= 10;
}

/** Remove email addresses and phone numbers from free text. */
export function redactPersonalData(text) {
    if (!text) return text;
    return String(text)
        .replace(EMAIL_RE, '[email removed]')
        .replace(PHONE_RE, (m) => (looksLikePhone(m) ? '[phone removed]' : m));
}

function stripScriptsAndComments(html) {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
}

/** Drop mailto:/tel: links (keep their visible text). */
function unlinkContacts(html) {
    return html.replace(/<a\b[^>]*href\s*=\s*["']?\s*(?:mailto|tel):[^>]*>([\s\S]*?)<\/a>/gi, '$1');
}

function tidyText(s) {
    return s
        .replace(/[ \t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^(- .*)\n\n(?=- )/gm, '$1\n')
        .replace(/^(- .*)\n\n(?=- )/gm, '$1\n')
        .trim();
}

export function htmlToText(html) {
    if (!html) return '';
    let s = unlinkContacts(stripScriptsAndComments(String(html)));
    s = s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|blockquote)>/gi, '\n')
        .replace(/<(p|div|h[1-6]|ul|ol|tr|table|section|blockquote)\b[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    s = decodeEntities(s).replace(/\n- \s*\n/g, '\n');
    return tidyText(s.replace(/\n-\s*(?:•|·)\s*/g, '\n- '));
}

function wrapInline(inner, mark) {
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

export function htmlToMarkdown(html) {
    if (!html) return '';
    let s = unlinkContacts(stripScriptsAndComments(String(html)));
    s = s
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, inner) => wrapInline(inner, '**'))
        .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, inner) => wrapInline(inner, '_'))
        .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
            const text = inner.replace(/<[^>]+>/g, '').trim();
            return text ? `[${text}](${href})` : '';
        })
        .replace(/<br\s*\/?>/gi, '  \n')
        .replace(/<li\b[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|ul|ol|table|section|blockquote)>/gi, '\n\n')
        .replace(/<\/(li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    s = decodeEntities(s).replace(/\n- \s*\n/g, '\n');
    return tidyText(s.replace(/\*\*\s*\*\*/g, ''));
}

/** Clean HTML for output: remove scripts, comments, contact links and inline styles. */
export function cleanHtml(html) {
    if (!html) return '';
    return unlinkContacts(stripScriptsAndComments(String(html)))
        .replace(/\s(style|class|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*')/gi, '')
        .trim();
}

// ---------- Normalisation ----------

const toIso = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function normEmploymentType(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
    if (s.includes('fulltime')) return 'full-time';
    if (s.includes('parttime')) return 'part-time';
    if (s.includes('intern')) return 'internship';
    if (s.includes('contract') || s.includes('freelance')) return 'contract';
    if (s.includes('temp')) return 'temporary';
    return String(raw).trim();
}

function normWorkplace(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
    if (s === 'remote') return 'remote';
    if (s === 'hybrid') return 'hybrid';
    if (s === 'onsite' || s === 'inoffice' || s === 'office') return 'onsite';
    return null;
}

function normInterval(raw) {
    if (!raw) return null;
    const s = String(raw).toLowerCase();
    if (/hour/.test(s)) return 'hour';
    if (/day|daily/.test(s)) return 'day';
    if (/week/.test(s)) return 'week';
    if (/month/.test(s)) return 'month';
    if (/year|annual|salary/.test(s)) return 'year';
    if (/one-?time/.test(s)) return 'one-time';
    return null;
}

const uniq = (arr) => [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))];
const hasRemote = (...strs) => strs.some((s) => /\bremote\b/i.test(String(s || '')));

function primarySalary(ranges) {
    const r = ranges[0];
    if (!r) return { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null };
    return { salaryMin: r.min, salaryMax: r.max, salaryCurrency: r.currency, salaryInterval: r.interval };
}

function normaliseGreenhouse(j, slug) {
    const locations = uniq(String(j.location?.name || '').split(/\s*[;|]\s*/));
    const isRemote = hasRemote(j.location?.name, j.title);
    const salaryRanges = (j.pay_input_ranges || [])
        .filter((r) => r && (r.min_cents != null || r.max_cents != null))
        .map((r) => {
            const min = r.min_cents != null ? r.min_cents / 100 : null;
            const max = r.max_cents != null ? r.max_cents / 100 : null;
            let interval = normInterval(r.title) || normInterval(htmlToText(decodeEntities(r.blurb || '')));
            if (!interval && (max ?? min) != null) {
                const v = max ?? min;
                interval = v >= 20000 ? 'year' : v <= 500 ? 'hour' : null;
            }
            return { min, max, currency: r.currency_type || null, interval, label: r.title || null };
        });
    return {
        jobId: String(j.id),
        ats: 'greenhouse',
        company: j.company_name || slug,
        companySlug: slug,
        title: String(j.title || '').trim(),
        department: j.departments?.[0]?.name || null,
        team: null,
        locations,
        isRemote,
        workplaceType: isRemote ? 'remote' : null,
        employmentType: null,
        ...primarySalary(salaryRanges),
        salaryRanges,
        _html: decodeEntities(j.content || ''),
        applyUrl: j.absolute_url || null,
        jobUrl: j.absolute_url || null,
        publishedAt: toIso(j.first_published),
        updatedAt: toIso(j.updated_at),
    };
}

function normaliseLever(j, slug, ats) {
    const c = j.categories || {};
    const locations = uniq(c.allLocations?.length ? c.allLocations : [c.location]);
    const workplaceType = normWorkplace(j.workplaceType);
    const sr = j.salaryRange;
    const salaryRanges = sr && (sr.min != null || sr.max != null)
        ? [{ min: sr.min ?? null, max: sr.max ?? null, currency: sr.currency || null, interval: normInterval(sr.interval), label: null }]
        : [];
    const listsHtml = (j.lists || [])
        .map((l) => `<h3>${l.text || ''}</h3><ul>${l.content || ''}</ul>`)
        .join('');
    return {
        jobId: String(j.id),
        ats,
        company: slug,
        companySlug: slug,
        title: String(j.text || '').trim(),
        department: c.department || null,
        team: c.team || null,
        locations,
        isRemote: workplaceType === 'remote' || hasRemote(...locations),
        workplaceType,
        employmentType: normEmploymentType(c.commitment),
        ...primarySalary(salaryRanges),
        salaryRanges,
        _html: `${j.description || ''}${listsHtml}${j.additional || ''}`,
        applyUrl: j.applyUrl || null,
        jobUrl: j.hostedUrl || null,
        publishedAt: toIso(j.createdAt),
        updatedAt: toIso(j.updatedAt),
    };
}

function normaliseAshby(j, slug) {
    const locations = uniq([j.location, ...(j.secondaryLocations || []).map((l) => l.location)]);
    const workplaceType = normWorkplace(j.workplaceType);
    const salaryRanges = [];
    for (const tier of j.compensation?.compensationTiers || []) {
        for (const comp of tier.components || []) {
            if (comp.compensationType !== 'Salary' || (comp.minValue == null && comp.maxValue == null)) continue;
            salaryRanges.push({
                min: comp.minValue ?? null,
                max: comp.maxValue ?? null,
                currency: comp.currencyCode || null,
                interval: normInterval(comp.interval),
                label: tier.title || null,
            });
        }
    }
    if (!salaryRanges.length) {
        for (const comp of j.compensation?.summaryComponents || []) {
            if (comp.compensationType !== 'Salary' || (comp.minValue == null && comp.maxValue == null)) continue;
            salaryRanges.push({ min: comp.minValue ?? null, max: comp.maxValue ?? null, currency: comp.currencyCode || null, interval: normInterval(comp.interval), label: null });
        }
    }
    return {
        jobId: String(j.id),
        ats: 'ashby',
        company: slug,
        companySlug: slug,
        title: String(j.title || '').trim(),
        department: j.department || null,
        team: j.team || null,
        locations,
        // Ashby sets isRemote on some hybrid roles; when a workplace type is given, trust it plus the locations.
        isRemote: workplaceType ? workplaceType === 'remote' || hasRemote(...locations) : Boolean(j.isRemote) || hasRemote(...locations),
        workplaceType,
        employmentType: normEmploymentType(j.employmentType),
        ...primarySalary(salaryRanges),
        salaryRanges,
        _html: j.descriptionHtml || '',
        applyUrl: j.applyUrl || null,
        jobUrl: j.jobUrl || null,
        publishedAt: toIso(j.publishedAt),
        updatedAt: toIso(j.updatedAt),
    };
}

export function normaliseJob(raw, ats, slug) {
    if (ats === 'greenhouse') return normaliseGreenhouse(raw, slug);
    if (ats === 'lever' || ats === 'lever-eu') return normaliseLever(raw, slug, 'lever');
    if (ats === 'ashby') return normaliseAshby(raw, slug);
    throw new Error(`Unknown ATS ${ats}`);
}

// ---------- Filtering and output ----------

const lowerList = (a) => (Array.isArray(a) ? a : a ? [a] : []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);

export function buildFilter({ keywords, locations, remoteOnly, departments, postedSinceDays, searchDescription } = {}) {
    const kw = lowerList(keywords);
    const locs = lowerList(locations);
    const deps = lowerList(departments);
    const cutoff = Number(postedSinceDays) > 0 ? Date.now() - Number(postedSinceDays) * 86400000 : null;
    return (job, descriptionText) => {
        if (remoteOnly && !job.isRemote) return false;
        if (kw.length) {
            const hay = [job.title, job.department, job.team, searchDescription ? descriptionText : ''].join(' \n ').toLowerCase();
            if (!kw.some((k) => hay.includes(k))) return false;
        }
        if (locs.length) {
            const hay = job.locations.join(' | ').toLowerCase();
            const ok = locs.some((l) => hay.includes(l) || (l === 'remote' && job.isRemote));
            if (!ok) return false;
        }
        if (deps.length) {
            const hay = [job.department, job.team].join(' | ').toLowerCase();
            if (!deps.some((d) => hay.includes(d))) return false;
        }
        if (cutoff) {
            const t = Date.parse(job.publishedAt || job.updatedAt || '');
            if (!Number.isFinite(t) || t < cutoff) return false;
        }
        return true;
    };
}

/**
 * Normalise, filter, sort (newest first), cap and render descriptions for one company's raw jobs.
 */
export function processCompanyJobs(rawJobs, ats, slug, input = {}) {
    const includeDescription = input.includeDescription !== false;
    const format = ['text', 'html', 'markdown'].includes(input.descriptionFormat) ? input.descriptionFormat : 'text';
    const filter = buildFilter(input);
    const scrapedAt = new Date().toISOString();
    const out = [];
    const jobs = rawJobs.map((r) => normaliseJob(r, ats, slug));
    jobs.sort((a, b) => (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0));
    const max = Number(input.maxJobsPerCompany) > 0 ? Number(input.maxJobsPerCompany) : Infinity;
    for (const job of jobs) {
        if (out.length >= max) break;
        const { _html, ...rest } = job;
        const needText = includeDescription || (input.searchDescription && lowerList(input.keywords).length);
        const descriptionText = needText ? redactPersonalData(htmlToText(_html)) : null;
        if (!filter(rest, descriptionText)) continue;
        const item = { ...rest };
        const tail = { applyUrl: item.applyUrl, jobUrl: item.jobUrl, publishedAt: item.publishedAt, updatedAt: item.updatedAt, scrapedAt };
        delete item.applyUrl; delete item.jobUrl; delete item.publishedAt; delete item.updatedAt;
        if (includeDescription) {
            item.descriptionText = descriptionText;
            if (format === 'html') item.descriptionHtml = redactPersonalData(cleanHtml(_html));
            if (format === 'markdown') item.descriptionMarkdown = redactPersonalData(htmlToMarkdown(_html));
        }
        out.push({ ...item, ...tail });
    }
    return { totalJobs: jobs.length, items: out };
}

/** Run async tasks with limited concurrency. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
