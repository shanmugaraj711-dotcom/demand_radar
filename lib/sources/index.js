'use strict';

const registry = require('./registry');
const common = require('./common');
const { YouTubeSourceAdapter } = require('./youtube');
const { XSourceAdapter } = require('./x');
const { LinkedInSourceAdapter } = require('./linkedin');
const { FacebookSourceAdapter } = require('./facebook');
const { InstagramSourceAdapter } = require('./instagram');
const { TikTokSourceAdapter } = require('./tiktok');
const { ThreadsSourceAdapter } = require('./threads');
const { GenericRssAdapter } = require('./rss');
const { GenericWebAdapter } = require('./web');

module.exports = {
  ...registry,
  ...common,
  YouTubeSourceAdapter,
  XSourceAdapter,
  LinkedInSourceAdapter,
  FacebookSourceAdapter,
  InstagramSourceAdapter,
  TikTokSourceAdapter,
  ThreadsSourceAdapter,
  GenericRssAdapter,
  GenericWebAdapter
};
