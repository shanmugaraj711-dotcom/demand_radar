'use strict';

const { RedditRssAdapter } = require('../reddit-rss');
const { YouTubeSourceAdapter } = require('./youtube');
const { XSourceAdapter } = require('./x');
const { LinkedInSourceAdapter } = require('./linkedin');
const { FacebookSourceAdapter } = require('./facebook');
const { InstagramSourceAdapter } = require('./instagram');
const { TikTokSourceAdapter } = require('./tiktok');
const { ThreadsSourceAdapter } = require('./threads');
const { GenericRssAdapter } = require('./rss');
const { GenericWebAdapter } = require('./web');
const { ingestBatch } = require('../ingestion');

/**
 * Common Source Registry for Demand Radar Multi-Source Ingestion.
 * Defines platform status, access capabilities, auth requirements, and rate limits.
 */
const SOURCE_DEFINITIONS = [
  {
    id: 'reddit_rss',
    aliases: ['reddit'],
    name: 'Reddit RSS',
    adapterClass: RedditRssAdapter,
    status: 'READY',
    auth_required: false,
    requires_approval: false,
    capability: 'Public Reddit RSS/Atom feeds for subreddits and search queries',
    rate_limits: 'Public RSS: ~1 request/sec recommended',
    max_fetch_size: 2 * 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 25, max: 100 },
    provenance: ['source: reddit_rss', 'source_id: t3_<id>', 'source_url', 'author: u/<name>', 'observed_at'],
    terms_notes: 'Public feeds via HTTPS; no private scraping or credential bypass'
  },
  {
    id: 'youtube',
    aliases: ['yt'],
    name: 'YouTube',
    adapterClass: YouTubeSourceAdapter,
    status: 'READY_WHEN_CONFIGURED',
    auth_required: true,
    requires_approval: false,
    capability: 'Official YouTube Data API v3 video search and snippet metadata',
    rate_limits: 'API quota units (100 units per search query; 10,000 units/day default)',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 50 },
    provenance: ['source: youtube', 'source_id: videoId', 'source_url: youtube.com/watch?v=...', 'author: channelTitle', 'observed_at'],
    terms_notes: 'Requires Google Cloud YouTube Data API v3 key (YOUTUBE_API_KEY). HTML scraping is strictly prohibited.'
  },
  {
    id: 'x',
    aliases: ['twitter'],
    name: 'X (Twitter)',
    adapterClass: XSourceAdapter,
    status: 'READY_WHEN_CONFIGURED',
    auth_required: true,
    requires_approval: false,
    capability: 'Official X API v2 recent search endpoint for public posts',
    rate_limits: 'Standard tier: 450 requests per 15-minute window',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 100 },
    provenance: ['source: x', 'source_id: tweet_id', 'source_url: x.com/i/status/...', 'author: @<username>', 'observed_at'],
    terms_notes: 'Requires X API v2 Bearer Token (X_BEARER_TOKEN). HTML scraping and browser automation are strictly prohibited.'
  },
  {
    id: 'linkedin',
    aliases: ['li'],
    name: 'LinkedIn',
    adapterClass: LinkedInSourceAdapter,
    status: 'DISABLED_APPROVAL_REQUIRED',
    auth_required: true,
    requires_approval: true,
    capability: 'Official LinkedIn Member Share and Community Management API',
    rate_limits: 'Per-application throttle as determined by LinkedIn Developer Partner tier',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 50 },
    provenance: ['source: linkedin', 'source_id: urn:li:share:...', 'source_url', 'author: urn:li:person/...', 'observed_at'],
    terms_notes: 'Disabled until approved. Requires LinkedIn Developer Enterprise/Partner Program access. Member post scraping is prohibited.'
  },
  {
    id: 'facebook',
    aliases: ['fb'],
    name: 'Facebook',
    adapterClass: FacebookSourceAdapter,
    status: 'DISABLED_APPROVAL_REQUIRED',
    auth_required: true,
    requires_approval: true,
    capability: 'Official Meta Graph API Page and public feed endpoints',
    rate_limits: 'App-level rate limiting based on active users (typically 200 calls/hour/user)',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 50 },
    provenance: ['source: facebook', 'source_id: post_id', 'source_url', 'author: page/user name', 'observed_at'],
    terms_notes: 'Disabled until approved. Requires Meta App Review with Page Public Content Access or User Graph permissions. HTML scraping is prohibited.'
  },
  {
    id: 'instagram',
    aliases: ['ig'],
    name: 'Instagram',
    adapterClass: InstagramSourceAdapter,
    status: 'DISABLED_APPROVAL_REQUIRED',
    auth_required: true,
    requires_approval: true,
    capability: 'Official Instagram Graph API business and hashtag search',
    rate_limits: 'Meta Graph API limits: 200 calls/hour per user or token',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 50 },
    provenance: ['source: instagram', 'source_id: media_id', 'source_url', 'author: @<username>', 'observed_at'],
    terms_notes: 'Disabled until approved. Requires Meta App Review for Instagram Graph API. Browser automation and unofficial scraping are prohibited.'
  },
  {
    id: 'tiktok',
    aliases: ['tt'],
    name: 'TikTok',
    adapterClass: TikTokSourceAdapter,
    status: 'DISABLED_APPROVAL_REQUIRED',
    auth_required: true,
    requires_approval: true,
    capability: 'Official TikTok Display & Research APIs (distinct approved tiers)',
    rate_limits: 'Research API quotas or Display API rate limits (typically 10-20 QPS)',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 50 },
    provenance: ['source: tiktok', 'source_id: video_id', 'source_url', 'author: @<username>', 'observed_at'],
    terms_notes: 'Disabled until approved. Commercial/public research queries require approved TikTok Research API access. HTML scraping is strictly prohibited.'
  },
  {
    id: 'threads',
    aliases: ['th'],
    name: 'Threads',
    adapterClass: ThreadsSourceAdapter,
    status: 'DISABLED_APPROVAL_REQUIRED',
    auth_required: true,
    requires_approval: true,
    capability: 'Official Meta Threads API public posts and profile threads',
    rate_limits: 'Threads API limits: 250 posts/replies per 24 hours; read limits per app',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 20, max: 50 },
    provenance: ['source: threads', 'source_id: thread_id', 'source_url', 'author: @<username>', 'observed_at'],
    terms_notes: 'Disabled until approved. Requires Meta Threads API token and app review. HTML scraping is strictly prohibited.'
  },
  {
    id: 'rss',
    aliases: ['feed', 'atom'],
    name: 'Generic RSS/Atom',
    adapterClass: GenericRssAdapter,
    status: 'READY_WHEN_CONFIGURED',
    auth_required: false,
    requires_approval: false,
    capability: 'Standard RSS 2.0 and Atom feeds from explicitly allow-listed hostnames',
    rate_limits: 'Per host throttle (recommended max 1 req/sec per origin)',
    max_fetch_size: 2 * 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 25, max: 100 },
    provenance: ['source: rss', 'source_id: sha256(guid/link)', 'source_url', 'author', 'observed_at'],
    terms_notes: 'HTTPS only; requires explicit hostname allow-list; rejects private IPs and redirects (redirect: error)'
  },
  {
    id: 'web',
    aliases: ['html', 'site'],
    name: 'Generic Web Page',
    adapterClass: GenericWebAdapter,
    status: 'READY_WHEN_CONFIGURED',
    auth_required: false,
    requires_approval: false,
    capability: 'Public web pages from explicitly allow-listed domains',
    rate_limits: 'Strict origin throttle (recommended max 1 req/sec per origin)',
    max_fetch_size: 1024 * 1024,
    timeout_ms: 8000,
    pagination_limits: { default: 1, max: 10 },
    provenance: ['source: web', 'source_id: sha256(url)', 'source_url', 'author', 'observed_at'],
    terms_notes: 'HTTPS only; requires explicit hostname allow-list; strictly no general unconstrained crawling; SSRF protected'
  }
];

/**
 * Returns a list of all registered source metadata with their active enabled state.
 */
function getSourceRegistry(env = process.env) {
  return SOURCE_DEFINITIONS.map(def => {
    let isReady = false;
    let effectiveStatus = def.status;

    if (def.id === 'reddit_rss') {
      isReady = true;
      effectiveStatus = 'READY';
    } else if (def.id === 'youtube') {
      if (env.YOUTUBE_API_KEY) {
        isReady = true;
        effectiveStatus = 'READY';
      } else {
        effectiveStatus = 'READY_WHEN_CONFIGURED';
      }
    } else if (def.id === 'x') {
      if (env.X_BEARER_TOKEN) {
        isReady = true;
        effectiveStatus = 'READY';
      } else {
        effectiveStatus = 'READY_WHEN_CONFIGURED';
      }
    } else if (def.id === 'rss' || def.id === 'web') {
      effectiveStatus = 'READY_WHEN_CONFIGURED';
      isReady = true; // ready as long as allowedHosts is passed in request
    } else {
      // Platform approval required
      effectiveStatus = 'DISABLED_APPROVAL_REQUIRED';
      isReady = false;
    }

    return {
      id: def.id,
      name: def.name,
      status: effectiveStatus,
      enabled: isReady,
      auth_required: def.auth_required,
      requires_approval: def.requires_approval,
      capability: def.capability,
      rate_limits: def.rate_limits,
      max_fetch_size: def.max_fetch_size,
      timeout_ms: def.timeout_ms,
      pagination_limits: def.pagination_limits,
      provenance: def.provenance,
      terms_notes: def.terms_notes
    };
  });
}

/**
 * Looks up a source definition by id or alias.
 */
function findSourceDefinition(sourceId) {
  if (!sourceId || typeof sourceId !== 'string') return null;
  const target = sourceId.trim().toLowerCase();
  return SOURCE_DEFINITIONS.find(s => s.id === target || s.aliases.includes(target)) || null;
}

/**
 * Creates an instance of a source adapter by source ID.
 */
function createSourceAdapter(sourceId, options = {}) {
  const def = findSourceDefinition(sourceId);
  if (!def) {
    throw new Error(`Unknown demand source "${sourceId}". Available sources: ${SOURCE_DEFINITIONS.map(s => s.id).join(', ')}`);
  }
  return new def.adapterClass(options);
}

/**
 * Orchestrates multi-source demand ingestion:
 *   adapter.fetch() → normalizeMention() → ingestBatch(db, mentions, options)
 *
 * Manual and on-demand only. Zero background polling daemons.
 */
async function ingestFromSource(db, sourceId, queryOrInput, options = {}) {
  const def = findSourceDefinition(sourceId);
  if (!def) {
    throw new Error(`Unknown demand source "${sourceId}". Available sources: ${SOURCE_DEFINITIONS.map(s => s.id).join(', ')}`);
  }

  const adapter = new def.adapterClass(options);
  const mentions = await adapter.fetch(queryOrInput, options);

  if (!mentions || !mentions.length) {
    return {
      source: def.id,
      total: 0,
      inserted: 0,
      duplicates: 0,
      rejected: 0,
      opportunities_created: 0,
      results: []
    };
  }

  const batchSummary = await ingestBatch(db, mentions, {
    evaluateRelevance: Boolean(options.evaluateRelevance !== false),
    ...options
  });
  return {
    source: def.id,
    ...batchSummary
  };
}

module.exports = {
  SOURCE_DEFINITIONS,
  getSourceRegistry,
  findSourceDefinition,
  createSourceAdapter,
  ingestFromSource
};
