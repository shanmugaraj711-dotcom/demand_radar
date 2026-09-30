'use strict';

const { normalizeMention } = require('./normalization');

/**
 * Base SourceAdapter interface for public-source ingestion.
 *
 * Designed to support future public platforms (Reddit, web search, forums, review sites)
 * without requiring any modifications to demand.js or product relevance engines.
 */
class SourceAdapter {
  constructor(name, config = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('SourceAdapter requires a non-empty string name.');
    }
    this.name = name.trim().toLowerCase();
    this.config = config;
  }

  /**
   * Normalizes a platform-specific raw item into the standard Mention contract:
   * { source, source_id, source_url, raw_text, observed_at, author, location_hint, metadata }
   *
   * Subclasses must implement this method.
   */
  normalize(rawItem) {
    throw new Error(`normalize() must be implemented by adapter "${this.name}"`);
  }

  /**
   * Extensibility hook for future live public collectors (e.g. reddit, forums).
   * In Phase 3, this is an explicit extensibility point; live crawlers are not included.
   */
  async fetch(query, options = {}) {
    throw new Error(`Live crawling is not implemented for adapter "${this.name}". Real-world collectors will be added in future phases.`);
  }
}

/**
 * Mock / Deterministic Mention Adapter for testing and synthetic pipelines.
 */
class MockMentionAdapter extends SourceAdapter {
  constructor(name = 'mock', config = {}) {
    super(name, config);
    this.fixtures = [];
  }

  seed(items) {
    if (Array.isArray(items)) {
      this.fixtures.push(...items);
    } else if (items) {
      this.fixtures.push(items);
    }
  }

  clear() {
    this.fixtures = [];
  }

  normalize(rawItem) {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error('Cannot normalize null or undefined item');
    }
    const input = {
      source: this.name,
      source_id: rawItem.source_id || rawItem.id || '',
      source_url: rawItem.source_url || rawItem.url || '',
      raw_text: rawItem.raw_text || rawItem.text || rawItem.content || rawItem.body || '',
      observed_at: rawItem.observed_at || rawItem.timestamp || rawItem.created_at || new Date().toISOString(),
      author: rawItem.author || rawItem.author_name || rawItem.user || '',
      location_hint: rawItem.location_hint || rawItem.location || '',
      metadata: rawItem.metadata || {}
    };
    return normalizeMention(input);
  }

  async fetch(query, options = {}) {
    let results = this.fixtures.map(f => this.normalize(f));
    if (query) {
      const q = String(query).toLowerCase();
      results = results.filter(r => r.raw_text.toLowerCase().includes(q));
    }
    return results;
  }
}

/**
 * PublicMentionAdapter: generic adapter for web, forum, or public search snippets.
 */
class PublicMentionAdapter extends MockMentionAdapter {
  constructor(name = 'public_mention', config = {}) {
    super(name, config);
  }
}

module.exports = {
  SourceAdapter,
  MockMentionAdapter,
  PublicMentionAdapter
};
