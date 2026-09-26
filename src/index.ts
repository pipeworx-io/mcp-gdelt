interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * GDELT MCP — Global Database of Events, Language, and Tone (free, no auth)
 *
 * GDELT 2.0 monitors print, broadcast, and web news worldwide in 100+ languages
 * every 15 minutes. The DOC API (v2/doc) is the right surface for AI agents:
 * article search, sentiment-over-time, and geographic news volume.
 *
 * API docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 * Tools:
 * - search_articles:  recent matching articles (URL, domain, tone, language)
 * - timeline_tone:    day-by-day tone (-100..+100) for a query
 * - timeline_volume:  day-by-day article volume (% of news coverage) for a query
 *
 * Query language quick ref:
 *   plain words → AND across all words
 *   "phrase"    → exact phrase
 *   (a OR b)    → OR group
 *   -word       → exclude
 *   sourcecountry:US, sourcelang:eng, theme:TERROR, near:"Paris"~50
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
// GDELT's DOC API is genuinely SLOW, not merely throttled. Measured 2026-09-01
// from a residential IP (i.e. nothing to do with our egress): 6 cold queries
// answered 200 at 25.8s, 58.3s and 27.5s, timed out twice at 60s, and 429'd
// once at 18.3s. The shared default of 25s sits ON that median, so we were
// aborting responses that were about to arrive and reporting them as failures.
// 30 cold queries through the deployed gateway that day answered 7 (23%); half
// the failures were our own 25s abort, not GDELT refusing.
//
// 35s, and the ceiling is NOT what picked it. The budget that applies to a
// direct tools/call is DEFAULT_BUDGET_MS = 75s (gdelt is not a FANOUT_TOOL), so
// far more was available. 35s is where the measurements stop: timing 10 cold
// calls through the deployed gateway, every success landed at 18.7s, 21.4s and
// 33.8s, and the 522s came back fast at ~20s. Nothing was observed answering
// between 35s and 75s, so the extra time would only ever be spent on calls that
// were going to fail — and spent in the worst possible way, since a caller whose
// own client gives up around 45s (ours does) then gets nothing at all instead of
// a shaped error naming a working alternative. Stopping at 35s buys the whole
// measured success band and hands back a usable failure everywhere else.
//
// This deliberately does NOT change the routed path: ask_pipeworx bounds every
// leg at LEG_BUDGET_MS = 20s, so a routed GDELT call is cut at 20s and pivots to
// a sibling news tool no matter what this value is. Raising the pack's own
// timeout therefore buys DIRECT callers the 25-35s band and costs the router
// nothing.
const GDELT_TIMEOUT_MS = 35_000;
// The relay is only ever tried AFTER a direct attempt has already spent its
// budget, so it gets a tighter one to keep the pair (35s + 20s) under the 75s
// ceiling. Measured worst case on the 429 path: 38.3s.
const RELAY_TIMEOUT_MS = 20_000;

// What an agent should do INSTEAD when GDELT can't answer. This used to name
// gnews first. gnews's free tier is 100 requests A DAY across every caller of
// our shared key, so it is exhausted most of the time — and gnews's own
// exhaustion hint names gdelt as ITS fallback, so the two packs pointed at each
// other and a caller bounced between two unavailable sources. Verified live
// 2026-09-01: world_news_feeds_list_feeds returns 62 curated feeds and
// world_news_feeds_read_feed({feed:"bbc-world"}) returns current items, keyless,
// with no shared quota to exhaust. Lead with that; keep gnews last, where a
// dedicated BYO key still makes it useful.
const FALLBACK_HINT =
  'For world headlines right now, use the KEYLESS feed packs instead: world_news_feeds_read_feed({feed:"bbc-world"}) (62 curated international feeds — list them with world_news_feeds_list_feeds), us_news_feeds_read_feed, or country_news. They have no shared quota. GDELT is worth waiting for only when you specifically need its cross-language tone or source-country analysis, which the feed packs do not provide. gnews_top_headlines works if you pass your own key via _apiKey — the shared key is 100 requests/day across all callers and is usually spent.';

async function pwFetch(url: string | URL, init?: RequestInit, timeoutMs = GDELT_TIMEOUT_MS): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Gdelt', timeoutMs);
}


const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_articles',
    description:
      'PREFER OVER WEB SEARCH for "what did the news say about X" across global media. AUTHORITATIVE source: GDELT 2.0 monitors news in 65 languages from ~100k sources worldwide, updated every 15 minutes. Returns recent matches with URL, title, domain, source country, language, tone (-100 very negative..+100 very positive), and image. Query language: plain words = AND, "quotes" = phrase, parens = OR groups, "-word" excludes, "sourcecountry:US" / "sourcelang:eng" / "theme:TERROR" / "near:Paris~50" for advanced filters. Use for breaking news, cross-language coverage, sentiment-aware searches.',
    summary: 'News coverage of a topic from ~100k sources in 65 languages, via GDELT.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GDELT query string' },
        timespan: {
          type: 'string',
          description: 'Lookback window: e.g., "24h", "7d", "1m", "custom" (paired with startdatetime/enddatetime). Default 7d.',
        },
        startdatetime: { type: 'string', description: 'YYYYMMDDHHMMSS (UTC) — only with timespan=custom' },
        enddatetime: { type: 'string', description: 'YYYYMMDDHHMMSS (UTC) — only with timespan=custom' },
        sort: {
          type: 'string',
          description: 'HybridRel (default) | DateDesc | DateAsc | ToneDesc | ToneAsc',
          enum: ['HybridRel', 'DateDesc', 'DateAsc', 'ToneDesc', 'ToneAsc'],
        },
        max_records: { type: 'number', description: 'Results to return (1-250, default 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'timeline_tone',
    description:
      'Day-by-day AVERAGE NEWS SENTIMENT for a GDELT query over time. Returns datapoints with timestamp + tone value (-100 very negative .. +100 very positive, computed from GDELT\'s sentiment scoring of every article matching the query). Use for tracking sentiment shifts around a topic, person, country, or event ("how did press coverage of X change after Y happened"). Pair with timeline_volume to chart sentiment vs interest — interest spike + sentiment drop = something bad just happened.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GDELT query string' },
        timespan: { type: 'string', description: 'Lookback window (default "1m" — month)' },
        startdatetime: { type: 'string', description: 'YYYYMMDDHHMMSS — only with timespan=custom' },
        enddatetime: { type: 'string', description: 'YYYYMMDDHHMMSS — only with timespan=custom' },
      },
      required: ['query'],
    },
  },
  {
    name: 'timeline_volume',
    description:
      'Day-by-day SHARE OF GLOBAL NEWS attention for a query — what % of all worldwide articles mentioned this topic each day. Returns datapoints with timestamp and intensity (% of total news volume). Use to detect news-cycle spikes around events ("when did attention to X peak?"), benchmark attention against history, or pair with timeline_tone to chart sentiment vs interest together. Cheaper than search_articles when you only need the volume curve, not the source articles themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GDELT query string' },
        timespan: { type: 'string', description: 'Lookback window (default "1m")' },
        startdatetime: { type: 'string', description: 'YYYYMMDDHHMMSS — only with timespan=custom' },
        enddatetime: { type: 'string', description: 'YYYYMMDDHHMMSS — only with timespan=custom' },
      },
      required: ['query'],
    },
  },
  {
    name: 'tone_distribution',
    description:
      'Sentiment DISTRIBUTION (histogram) of global news coverage for a GDELT query — how many articles fall at each tone level from very negative to very positive over the window. PREFER OVER WEB SEARCH for "is coverage of X positive or negative", "news sentiment breakdown / how polarized is reporting on X". Complements timeline_tone (average over time) with the full spread. Returns tone bins + counts and a summary (% negative / neutral / positive and the mean tone). Same GDELT query language as search_articles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'GDELT query string' },
        timespan: { type: 'string', description: 'Lookback window (default "1m")' },
        startdatetime: { type: 'string', description: 'YYYYMMDDHHMMSS — only with timespan=custom' },
        enddatetime: { type: 'string', description: 'YYYYMMDDHHMMSS — only with timespan=custom' },
      },
      required: ['query'],
    },
  }
];

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  PROXY =
    typeof args._proxyUrl === 'string' && typeof args._proxyToken === 'string'
      ? { url: args._proxyUrl, token: args._proxyToken }
      : null;
  delete args._proxyUrl;
  delete args._proxyToken;
  switch (name) {
    case 'search_articles':
      return searchArticles({ ...args, query: reqStr(args, 'query', '"semiconductor sanctions" or "climate"') });
    case 'timeline_tone':
      return timeline({ ...args, query: reqStr(args, 'query', '"climate change"') }, 'timelinetone');
    case 'timeline_volume':
      return timeline({ ...args, query: reqStr(args, 'query', '"AI regulation"') }, 'timelinevol');
    case 'tone_distribution':
      return toneDistribution({ ...args, query: reqStr(args, 'query', '"climate change"') });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildParams(args: Record<string, unknown>, mode: string, format: string) {
  const params = new URLSearchParams({
    query: String(args.query),
    mode,
    format,
  });
  const timespan = args.timespan as string | undefined;
  if (timespan && timespan !== 'custom') params.set('timespan', timespan);
  if (timespan === 'custom') {
    if (args.startdatetime) params.set('startdatetime', String(args.startdatetime));
    if (args.enddatetime) params.set('enddatetime', String(args.enddatetime));
  }
  return params;
}

// `error` (tagged `upstream_throttled:` / `upstream_down:`) is set ONLY on the
// throttle/origin-down paths so the gateway's executeTool marks the call failed
// and ask_pipeworx's retry loop pivots to a SIBLING news tool (gnews/newsdata)
// with the same args — instead of an agent hammering GDELT's 429 forever
// (which is what "what's the world saying about X" did before this). No-results
// and query-syntax cases stay error-free: a sibling can't fix those.
type GdeltFetchResult<T> = T | { found: false; reason: 'rate_limit' | 'query_syntax' | 'upstream_error'; hint: string; retry_after_sec: number | null; error?: string; relay?: RelayTrace };

// Set per call from the gateway's _proxyUrl/_proxyToken (see callTool).
let PROXY: { url: string; token: string } | null = null;

// GDELT's own index refreshes every 15 minutes, so nothing served inside that
// window is staler than the upstream itself is.
const FRESH_TTL_SEC = 900;
// How long a body stays READABLE for the stale path below. GDELT refuses far
// more than the cap it documents (see the 429 hint), so the real choice on a
// refusal is "a 40-minute-old answer" vs "no answer at all" — and for a 7-day
// news search those are very nearly the same answer. At 6h they are not, so
// past that we stop pretending and return the failure.
const STALE_MAX_SEC = 21600;
// Deliberately NOT the real GDELT URL: Cloudflare's `cf:`-managed entry lives
// under that URL and may hold a short-lived 429, which must never be handed
// back as though it were an answer.
const CACHE_KEY_PREFIX = 'https://gdelt-cache.pipeworx.invalid/';
// Age is tracked by us, not by Cache-Control: the entry is stored with a 6h
// s-maxage so it survives to BE stale, which means CF's own freshness has
// nothing to say about whether we should serve it.
const FETCHED_AT_HEADER = 'x-pw-fetched-at';

type CacheMeta = {
  stale: boolean;
  cache_age_sec: number;
  source: 'fresh-cache' | 'stale-cache' | 'upstream' | 'upstream-relay';
};

function decodeGdelt<T>(body: string, meta: CacheMeta): GdeltFetchResult<T> {
  // GDELT sometimes returns HTML error pages with 200 status — guard the parse.
  try {
    const parsed = JSON.parse(body) as T;
    if (parsed && typeof parsed === 'object') {
      (parsed as Record<string, unknown>)._cache = meta;
    }
    return parsed;
  } catch {
    return {
      found: false,
      reason: 'query_syntax',
      hint: `GDELT returned non-JSON (likely a query syntax error). First 200 chars: ${body.slice(0, 200)}`,
      retry_after_sec: null, // syntax errors aren't transient
    };
  }
}

async function cacheRead(key: Request): Promise<{ body: string; ageSec: number } | null> {
  const hit = await caches.default.match(key).catch(() => undefined);
  if (!hit) return null;
  const at = Number(hit.headers.get(FETCHED_AT_HEADER) ?? 0);
  // No stamp means we cannot say how old it is, and an answer of unknown age is
  // exactly what this pack must not hand back. Treat it as a miss.
  if (!at) return null;
  return { body: await hit.text(), ageSec: Math.max(0, Math.round((Date.now() - at) / 1000)) };
}

async function cacheWrite(key: Request, body: string): Promise<void> {
  await caches.default
    .put(
      key,
      new Response(body, {
        headers: {
          'content-type': 'application/json',
          'Cache-Control': `s-maxage=${STALE_MAX_SEC}`,
          [FETCHED_AT_HEADER]: String(Date.now()),
        },
      }),
    )
    .catch(() => {
      /* caching is an optimisation; a failed put must not fail the call */
    });
}

// ONE relay attempt, deliberately — measured 2026-08-18, in this order:
//   * retrying at 600ms/1200ms asks the same question inside the same 5-second
//     window it was just refused for: 3 attempts, 3 429s, ~50s spent proving it.
//   * respacing to 5.2s did not help either. 8 live calls answered 3 — no better
//     than the 43% (49/113) we had before the relay was wired — because each
//     call was now firing FOUR requests at GDELT, so our own retries were the
//     thing exhausting the 1-req/5-sec cap. Retrying is self-defeating here.
//   * failing fast is worth more than a slow success anyway: `upstream_throttled`
//     makes ask_pipeworx pivot to a sibling news tool, and a 60-second hang
//     before that pivot is strictly worse for the caller than a 25-second one.
// So: try the relay's IP once, then shape the failure and let the pivot happen.
// What the relay did, reported back on the failure path. Without this a relay
// that is itself being throttled is indistinguishable from a relay that was
// never configured — both just surface as "GDELT 429", which is the wrong
// thing to go debug.
type RelayTrace = { attempted: boolean; attempts: number; last_status: number | null; last_error: string | null };

async function relayFetch(target: string, trace: RelayTrace): Promise<Response | null> {
  if (!PROXY) return null;
  trace.attempted = true;
  trace.attempts++;
  try {
    const relayed = await pwFetch(
      PROXY.url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      },
      RELAY_TIMEOUT_MS,
    );
    trace.last_status = relayed.status;
    if (relayed.ok) return relayed;
    trace.last_error = (await relayed.text().catch(() => '')).slice(0, 160);
    return null;
  } catch (e) {
    trace.last_error = String(e).slice(0, 160);
    return null;
  }
}

type UpstreamResult =
  | { ok: true; body: string; via: 'upstream' | 'upstream-relay' }
  | { ok: false; failure: Extract<GdeltFetchResult<never>, { found: false }> };

// Concurrent identical queries inside one isolate share ONE upstream request.
// Five callers asking the same question in the same second used to be five
// requests against a 1-req/5-sec cap: four were arithmetically guaranteed to
// fail, and worse, they made US the traffic exhausting the cap. Keyed by the
// full parameter string, so it only ever merges genuinely identical queries.
const INFLIGHT = new Map<string, Promise<UpstreamResult>>();

async function fetchUpstream(target: string): Promise<UpstreamResult> {
  let res: Response;
  try {
    res = await pwFetch(target, {
      cf: {
        cacheTtlByStatus: { '200-299': 900, '400-499': 30, '500-599': 5 },
        cacheEverything: true,
      },
    } as RequestInit);
  } catch (e) {
    // A timeout or a dropped connection must come back as a FAILURE VALUE, not
    // a throw. Throwing skipped step 3 of gdeltFetch entirely, so a request
    // that timed out returned a hard tool_error while a perfectly serviceable
    // cached body — under six hours old, which for a 7-day news search is very
    // nearly the same answer — sat unread one line below. Measured 2026-09-01:
    // the 25s abort was the single most common gdelt outcome on the deployed
    // gateway (15 of 30 cold queries), so this was the dominant path and it was
    // the one path that could not reach the cache.
    //
    // fetchWithTimeout already prefixes its message with `upstream_down:`, which
    // is what makes ask_pipeworx classify this as the upstream's fault and pivot
    // to a sibling news tool. That token only routes from position 0, though, and
    // here the caught message becomes a FRAGMENT inside a longer hint — so drop
    // it here and let the `error` field below declare the class itself. This is
    // what check:class-prefix enforces, and it caught the first version of this
    // block doing exactly the wrong thing.
    const detail = e instanceof Error ? e.message : String(e);
    const hint = `${dropClassPrefix(detail).slice(0, 200)} ${FALLBACK_HINT}`;
    return {
      ok: false,
      failure: {
        found: false,
        reason: 'upstream_error',
        hint,
        retry_after_sec: 15,
        error: `upstream_down: ${dropClassPrefix(hint)}`,
      },
    };
  }
  // Direct-first is deliberate: that path keeps the CF edge cache above, which
  // matches GDELT's own 15-minute index refresh. The cap is per-IP though, and
  // we share a handful of CF egress IPs with everyone, so a caller can trip it
  // having made one request. On a 429 only, try the non-CF relay's IP once. If
  // the relay is unset or its allow-list hasn't learned the host, keep the
  // original 429 and fall through to the shaped rate_limit failure.
  if (res.status === 429) {
    const trace: RelayTrace = { attempted: false, attempts: 0, last_status: null, last_error: null };
    const relayed = await relayFetch(target, trace);
    if (relayed) return { ok: true, body: await relayed.text(), via: 'upstream-relay' };
    // Measured 2026-08-18, because the previous wording sent two people to
    // debug the wrong thing: this is NOT specific to our Cloudflare egress.
    // GDELT refused the non-CF relay IP as well, and refused a clean
    // residential IP on 2 of 3 calls spaced 12 seconds apart — far outside the
    // 1-req/5-sec cap it documents. Our own volume is roughly one call per 25
    // minutes, so we are not the traffic exhausting anything. Say what is
    // actually known instead of naming a cause we have ruled out.
    const hint = 'GDELT 429 — the DOC API refused this request, and we had no cached answer for it (results are cached 15 min fresh / 6h serve-stale, so a query anyone has asked recently is answered without touching GDELT at all). GDELT documents a cap of 1 req / 5 sec per IP, but measured 2026-08-18 it refuses far more than that: both of our egress paths (Cloudflare and the non-CF relay) and an unrelated residential IP were all throttled at wider spacing than the cap. Treat GDELT as best-effort on a cold query. ' + FALLBACK_HINT;
    return {
      ok: false,
      failure: {
        found: false,
        reason: 'rate_limit',
        hint,
        retry_after_sec: 5, // GDELT's per-IP cap is 1 req / 5 sec
        relay: trace,
        // Tagged so the gateway retries a sibling news tool (see type comment).
        error: `upstream_throttled: ${hint}`,
      },
    };
  }
  if (!res.ok) {
    const text = await res.text();
    // CF 5xx statuses (520-525) indicate origin connection failure — same
    // shape of "try again" retry guidance as the 429 path, just different
    // root cause (origin not responding vs being rate-limited). Run 7
    // audit flagged the inconsistency: 429 had retry guidance, 522 was
    // silent.
    const isOriginFlaky = res.status >= 520 && res.status <= 530;
    const hint = isOriginFlaky
      ? `GDELT ${res.status} — origin connection failure (CF couldn't reach api.gdeltproject.org). Transient; retry in a few seconds. Errors are cached briefly so we don't hammer the upstream. ${FALLBACK_HINT}`
      : `GDELT ${res.status}: ${text.slice(0, 200)}`;
    return {
      ok: false,
      failure: {
        found: false,
        reason: 'upstream_error',
        hint,
        retry_after_sec: isOriginFlaky ? 15 : null,
        // Only the transient origin-down case is retriable on a sibling; a 4xx
        // (bad query) is deterministic, so it stays error-free (no retry-fanout).
        ...(isOriginFlaky ? { error: `upstream_down: ${hint}` } : {}),
      },
    };
  }
  return { ok: true, body: await res.text(), via: 'upstream' };
}

async function gdeltFetch<T>(params: URLSearchParams): Promise<GdeltFetchResult<T>> {
  const target = `${BASE_URL}?${params}`;
  const cacheUrl = `${CACHE_KEY_PREFIX}?${params}`;
  const key = new Request(cacheUrl);

  // 1. Fresh enough that GDELT itself has nothing newer — answer without a
  //    round trip. This is the half of the cache Cloudflare cannot do for us:
  //    a relayed body arrives as the response to a POST at the proxy, so CF has
  //    no way to key it by the GDELT URL.
  const cached = await cacheRead(key);
  if (cached && cached.ageSec < FRESH_TTL_SEC) {
    return decodeGdelt<T>(cached.body, { stale: false, cache_age_sec: cached.ageSec, source: 'fresh-cache' });
  }

  // 2. One upstream request per distinct query in flight, however many callers
  //    are waiting on it.
  let flight = INFLIGHT.get(cacheUrl);
  if (!flight) {
    flight = fetchUpstream(target).finally(() => INFLIGHT.delete(cacheUrl));
    INFLIGHT.set(cacheUrl, flight);
  }
  const up = await flight;

  if (up.ok) {
    const decoded = decodeGdelt<T>(up.body, { stale: false, cache_age_sec: 0, source: up.via });
    // Only cache what parsed. GDELT serves HTML error pages with a 200 status,
    // and caching one would pin an error into the stale path for six hours.
    if ((decoded as { found?: boolean }).found !== false) await cacheWrite(key, up.body);
    return decoded;
  }

  // 3. Upstream refused and we have an older copy. A stale answer beats no
  //    answer here: GDELT's index only moves every 15 minutes, so a 40-minute-old
  //    7-day news search is very nearly the answer the failed request would have
  //    returned — and it is unambiguously better than the 429 this used to give
  //    back. Flagged `stale: true` with its age so a caller is never misled
  //    about what it is holding.
  if (cached && cached.ageSec < STALE_MAX_SEC) {
    return decodeGdelt<T>(cached.body, { stale: true, cache_age_sec: cached.ageSec, source: 'stale-cache' });
  }
  return up.failure as GdeltFetchResult<T>;
}

// A caller that got a cached answer should be able to tell — silently serving a
// 40-minute-old result as though it were live is the failure mode this whole
// cache is one bad decision away from. `stale` is true only when we served an
// old body BECAUSE the live fetch was refused.
function cacheFields(data: unknown) {
  const meta = (data as { _cache?: CacheMeta })._cache;
  if (!meta) return {};
  return {
    stale: meta.stale,
    cache_age_sec: meta.cache_age_sec,
    served_from: meta.source,
    ...(meta.stale
      ? {
          cache_note: `GDELT refused a live request, so this is the cached answer from ${meta.cache_age_sec}s ago. GDELT's index only refreshes every 15 min, so it is likely current; treat timestamps as of that age.`,
        }
      : {}),
  };
}

async function searchArticles(args: Record<string, unknown>) {
  const params = buildParams(args, 'ArtList', 'json');
  if (!args.timespan) params.set('timespan', '7d');
  if (args.sort) params.set('sort', String(args.sort));
  // max_records is a PRESENTATION choice, so it must not reach the request URL:
  // there it becomes a cache-key dimension, and a caller asking for 5 could not
  // reuse the answer already fetched for a caller who asked for 25 — one upstream
  // request each, against a cap that refuses almost everything. Ask GDELT for the
  // full page once, cache that, and slice locally.
  const want = Math.min(250, Math.max(1, (args.max_records as number) ?? 25));
  params.set('maxrecords', '250');

  const data = await gdeltFetch<{
    articles?: {
      url?: string;
      url_mobile?: string;
      title?: string;
      seendate?: string;
      socialimage?: string;
      domain?: string;
      language?: string;
      sourcecountry?: string;
      tone?: number;
    }[];
  }>(params);
  if ((data as { found?: boolean }).found === false) return data;
  const d = data as { articles?: Array<{ url?: string; url_mobile?: string; title?: string; seendate?: string; socialimage?: string; domain?: string; language?: string; sourcecountry?: string; tone?: number }> };

  return {
    query: args.query,
    timespan: args.timespan ?? '7d',
    ...cacheFields(data),
    returned: Math.min(want, d.articles?.length ?? 0),
    articles: (d.articles ?? []).slice(0, want).map((a) => ({
      url: a.url ?? null,
      title: a.title ?? null,
      seen_at: a.seendate ?? null,
      domain: a.domain ?? null,
      language: a.language ?? null,
      source_country: a.sourcecountry ?? null,
      tone: typeof a.tone === 'number' ? a.tone : null,
      image: a.socialimage ?? null,
    })),
  };
}

async function timeline(args: Record<string, unknown>, mode: 'timelinetone' | 'timelinevol') {
  const params = buildParams(args, mode, 'json');
  if (!args.timespan) params.set('timespan', '1m');

  const data = await gdeltFetch<{
    timeline?: {
      series?: string;
      data?: { date: string; value: number }[];
    }[];
  }>(params);
  if ((data as { found?: boolean }).found === false) return data;
  const d = data as { timeline?: Array<{ series?: string; data?: Array<{ date: string; value: number }> }> };

  const series = d.timeline?.[0]?.data ?? [];
  return {
    query: args.query,
    timespan: args.timespan ?? '1m',
    metric: mode === 'timelinetone' ? 'avg_tone (-100..+100)' : 'volume_pct (% of news)',
    ...cacheFields(data),
    points: series.length,
    series: series.map((d) => ({ date: d.date, value: d.value })),
  };
}

async function toneDistribution(args: Record<string, unknown>) {
  const params = buildParams(args, 'tonechart', 'json');
  if (!args.timespan) params.set('timespan', '1m');
  const data = await gdeltFetch<{ tonechart?: { bin?: number; count?: number }[] }>(params);
  if ((data as { found?: boolean }).found === false) return data;
  const d = data as { tonechart?: Array<{ bin?: number; count?: number }> };
  const bins = (d.tonechart ?? []).map((b) => ({ tone: b.bin ?? 0, count: b.count ?? 0 }));
  const total = bins.reduce((n, b) => n + b.count, 0);
  const sum = bins.reduce((n, b) => n + b.tone * b.count, 0);
  const neg = bins.filter((b) => b.tone < 0).reduce((n, b) => n + b.count, 0);
  const pos = bins.filter((b) => b.tone > 0).reduce((n, b) => n + b.count, 0);
  const neu = total - neg - pos;
  const pct = (x: number) => (total ? Math.round((x / total) * 1000) / 10 : 0);
  return {
    query: args.query,
    timespan: args.timespan ?? '1m',
    ...cacheFields(data),
    total_articles: total,
    summary: {
      mean_tone: total ? Math.round((sum / total) * 100) / 100 : null,
      pct_negative: pct(neg),
      pct_neutral: pct(neu),
      pct_positive: pct(pos),
    },
    bins,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
