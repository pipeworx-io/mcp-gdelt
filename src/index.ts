interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
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


const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_articles',
    description:
      'Search global news articles indexed by GDELT 2.0. Returns recent matches with URL, title, domain, source country, language, tone (-100..+100), and image. Use the query language: plain words AND together, "quotes" for phrases, parens for OR groups, "-word" to exclude, "sourcecountry:US" / "sourcelang:eng" / "theme:TERROR" / "near:Paris~50" for advanced filters.',
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
      'Day-by-day average tone (-100 very negative .. +100 very positive) for a GDELT query over time. Returns datapoints with timestamp and tone value. Useful for tracking sentiment shifts around a topic, person, or place.',
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
      'Day-by-day article volume as % of total news for a GDELT query. Returns datapoints with timestamp and intensity. Useful for spotting topic spikes and comparing news attention across periods.',
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
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_articles':
      return searchArticles(args);
    case 'timeline_tone':
      return timeline(args, 'timelinetone');
    case 'timeline_volume':
      return timeline(args, 'timelinevol');
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

async function gdeltFetch<T>(params: URLSearchParams): Promise<T> {
  const res = await fetch(`${BASE_URL}?${params}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GDELT error: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = await res.text();
  // GDELT sometimes returns HTML error pages with 200 status — guard the parse.
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`GDELT returned non-JSON (likely a query syntax error): ${body.slice(0, 200)}`);
  }
}

async function searchArticles(args: Record<string, unknown>) {
  const params = buildParams(args, 'ArtList', 'json');
  if (!args.timespan) params.set('timespan', '7d');
  if (args.sort) params.set('sort', String(args.sort));
  params.set('maxrecords', String(Math.min(250, Math.max(1, (args.max_records as number) ?? 25))));

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

  return {
    query: args.query,
    timespan: args.timespan ?? '7d',
    returned: data.articles?.length ?? 0,
    articles: (data.articles ?? []).map((a) => ({
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

  const series = data.timeline?.[0]?.data ?? [];
  return {
    query: args.query,
    timespan: args.timespan ?? '1m',
    metric: mode === 'timelinetone' ? 'avg_tone (-100..+100)' : 'volume_pct (% of news)',
    points: series.length,
    series: series.map((d) => ({ date: d.date, value: d.value })),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
