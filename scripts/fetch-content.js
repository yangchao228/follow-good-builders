#!/usr/bin/env node

// ============================================================================
// Follow Builders — Content Fetcher
// ============================================================================
// This script fetches new content from YouTube podcasts (via Supadata API) and
// X/Twitter accounts (via Rettiwt-API). It tracks what's already been processed in a
// state file so you never get duplicate content in your digest.
//
// Usage: node fetch-content.js [--lookback-hours 24]
// Output: JSON to stdout with all new content, organized by source
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';
import lockfile from 'proper-lockfile';
import { Rettiwt } from 'rettiwt-api';

// -- Constants ---------------------------------------------------------------

// Where user config and state live
const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const STATE_PATH = join(USER_DIR, 'state.json');
const ENV_PATH = join(USER_DIR, '.env');

// How far back to look for new content (overridable via --lookback-hours flag)
const DEFAULT_LOOKBACK_HOURS = 24;

// How many days of state to keep before pruning old entries
const STATE_RETENTION_DAYS = 90;

// Supadata API base URL
const SUPADATA_BASE = 'https://api.supadata.ai/v1';

// URL to fetch the latest default sources from GitHub
// This ensures users always get the most up-to-date builder list
// without needing to git pull or reinstall the skill
const REMOTE_SOURCES_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/config/default-sources.json';

// -- Config Loading ----------------------------------------------------------

// Loads the user's config.json and merges it with default sources.
// The merge logic: start with all defaults, then add user additions and
// remove user removals. This way users can customize without losing defaults.
//
// Default sources are fetched from GitHub so users automatically get
// the latest curated list. Falls back to the local file if offline.
async function loadConfig() {
  // Try to fetch the latest default sources from GitHub
  // If that fails (offline, rate-limited, etc.), fall back to the local copy
  let defaultSources;
  try {
    const res = await fetch(REMOTE_SOURCES_URL);
    if (res.ok) {
      defaultSources = await res.json();
      // Loaded latest sources from GitHub — no need to log this
    } else {
      throw new Error(`GitHub returned ${res.status}`);
    }
  } catch (err) {
    // Could not fetch remote sources, using local copy — not a problem
    const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
    const defaultSourcesPath = join(scriptDir, '..', 'config', 'default-sources.json');
    defaultSources = JSON.parse(await readFile(defaultSourcesPath, 'utf-8'));
  }

  // Load user config (may not exist yet on first run)
  let userConfig = {};
  if (existsSync(CONFIG_PATH)) {
    userConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  // Merge sources: defaults + user additions - user removals
  const sources = userConfig.sources || {};
  const podcasts = [
    ...defaultSources.podcasts.filter(
      p => !(sources.removedPodcasts || []).includes(p.name)
    ),
    ...(sources.addedPodcasts || [])
  ];
  const xAccounts = [
    ...defaultSources.x_accounts.filter(
      a => !(sources.removedXAccounts || []).includes(a.handle)
    ),
    ...(sources.addedXAccounts || [])
  ];

  return {
    language: userConfig.language || 'en',
    timezone: userConfig.timezone || 'America/Los_Angeles',
    frequency: userConfig.frequency || 'daily',
    podcasts,
    xAccounts
  };
}

// -- State Management --------------------------------------------------------

// The state file tracks which videos and tweets we've already processed.
// It uses file locking to prevent corruption if two runs overlap
// (e.g., a manual /ai trigger while a cron job is running).

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { processedVideos: {}, processedTweets: {}, lastUpdated: null };
  }
  return JSON.parse(await readFile(STATE_PATH, 'utf-8'));
}

async function saveState(state) {
  // Prune entries older than 90 days to prevent the file from growing forever
  const cutoff = Date.now() - (STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  for (const [id, timestamp] of Object.entries(state.processedVideos)) {
    if (timestamp < cutoff) delete state.processedVideos[id];
  }
  for (const [id, timestamp] of Object.entries(state.processedTweets)) {
    if (timestamp < cutoff) delete state.processedTweets[id];
  }

  state.lastUpdated = Date.now();
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- YouTube Fetching (Supadata API) -----------------------------------------

// Fetches recent videos from a YouTube channel or playlist, then grabs
// transcripts for any we haven't seen before. Supadata charges 1 credit
// per transcript, so we only fetch what's new.
//
// Supadata API endpoints:
//   GET /v1/youtube/channel/videos?id=<handle>&type=video — returns { video_ids: [] }
//   GET /v1/youtube/playlist/videos?id=<playlistId>       — returns { video_ids: [] }
//   GET /v1/youtube/transcript?url=<full youtube URL>&text=true — returns { content, lang, availableLangs }
//   GET /v1/youtube/video?id=<videoId>                     — returns video metadata (title, etc.)

async function fetchYouTubeContent(podcasts, state, apiKey, isFirstRun, errors, lookbackHours) {
  const results = [];

  for (const podcast of podcasts) {
    try {
      // Step 1: Get recent video IDs from this channel or playlist
      // The endpoint returns just an array of video ID strings, not full objects
      let videosUrl;
      if (podcast.type === 'youtube_playlist') {
        videosUrl = `${SUPADATA_BASE}/youtube/playlist/videos?id=${podcast.playlistId}`;
      } else {
        videosUrl = `${SUPADATA_BASE}/youtube/channel/videos?id=${podcast.channelHandle}&type=video`;
      }

      const videosRes = await fetch(videosUrl, {
        headers: { 'x-api-key': apiKey }
      });

      if (!videosRes.ok) {
        errors.push(`Failed to fetch videos for ${podcast.name}: HTTP ${videosRes.status}`);
        continue;
      }

      const videosData = await videosRes.json();
      // Supadata returns "videoIds" (camelCase), not "video_ids"
      const videoIds = videosData.videoIds || videosData.video_ids || [];

      // Step 2: Filter to videos we haven't processed yet
      const newVideoIds = videoIds.filter(id => !state.processedVideos[id]);

      if (newVideoIds.length === 0) continue;

      // Step 3: Limit how many we process per run
      // On first run (welcome digest), only grab the 1-2 most recent
      // On regular runs, process up to 3 new videos per channel
      const limit = isFirstRun ? 2 : 3;
      const videosToProcess = newVideoIds.slice(0, limit);

      // Step 4: For each candidate video, get metadata to check publish date.
      // On first run: prefer videos from the last 48 hours, but if none exist
      // for this channel, fall back to the single most recent video so the
      // welcome digest always has something to show.
      // On regular runs: use the configured lookback window.
      const maxAgeHours = isFirstRun ? 48 : lookbackHours;
      const videoCutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

      // First, fetch metadata for all candidates so we can pick the best ones
      const candidates = [];
      for (const videoId of videosToProcess) {
        try {
          const metaRes = await fetch(
            `${SUPADATA_BASE}/youtube/video?id=${videoId}`,
            { headers: { 'x-api-key': apiKey } }
          );
          let title = 'Untitled';
          let publishedAt = null;
          if (metaRes.ok) {
            const metaData = await metaRes.json();
            title = metaData.title || 'Untitled';
            publishedAt = metaData.uploadDate || metaData.publishedAt || metaData.date || null;
          }
          candidates.push({ videoId, title, publishedAt });
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          errors.push(`Error fetching metadata for video ${videoId}: ${err.message}`);
        }
      }

      // Filter to recent videos
      let selectedVideos = candidates.filter(v => {
        if (!v.publishedAt) return true; // include if no date (can't filter)
        return new Date(v.publishedAt) >= videoCutoff;
      });

      // On first run: if no videos passed the 48h filter for this channel,
      // take the single most recent one anyway so the welcome digest isn't empty
      if (isFirstRun && selectedVideos.length === 0 && candidates.length > 0) {
        selectedVideos = [candidates[0]]; // first = most recent from Supadata
      }

      // On first run, cap at 1 episode per channel
      if (isFirstRun) {
        selectedVideos = selectedVideos.slice(0, 1);
      }

      // Now fetch transcripts only for selected videos
      for (const video of selectedVideos) {
        try {
          const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
          const transcriptRes = await fetch(
            `${SUPADATA_BASE}/youtube/transcript?url=${encodeURIComponent(videoUrl)}&text=true`,
            { headers: { 'x-api-key': apiKey } }
          );

          if (!transcriptRes.ok) {
            errors.push(`Failed to fetch transcript for video ${video.videoId}: HTTP ${transcriptRes.status}`);
            continue;
          }

          const transcriptData = await transcriptRes.json();

          results.push({
            source: 'podcast',
            name: podcast.name,
            title: video.title,
            videoId: video.videoId,
            url: `https://youtube.com/watch?v=${video.videoId}`,
            publishedAt: video.publishedAt,
            transcript: transcriptData.content || '',
            language: transcriptData.lang || 'en'
          });

          // Mark as processed
          state.processedVideos[video.videoId] = Date.now();

          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`Error fetching transcript for video ${video.videoId}: ${err.message}`);
        }
      }

      // Mark skipped candidates as processed so we don't re-check them
      for (const v of candidates) {
        if (!state.processedVideos[v.videoId]) {
          state.processedVideos[v.videoId] = Date.now();
        }
      }
    } catch (err) {
      errors.push(`Error processing podcast ${podcast.name}: ${err.message}`);
    }
  }

  return results;
}

// -- X/Twitter Fetching (Rettiwt-API) ----------------------------------------

// Uses Rettiwt-API in guest mode to fetch recent tweets from each builder.
// Guest mode means NO login required and NO risk of account bans.
// It accesses Twitter's internal API the same way a logged-out browser does.
//
// How it works:
//   1. Get user's numeric ID via rettiwt.user.details(handle)
//   2. Fetch their timeline via rettiwt.user.timeline(userId, count)
//   3. Filter to tweets within our lookback window
//
// Rate limiting: Twitter's internal API has dynamic rate limits.
// We add delays between requests to stay under the radar.

async function fetchXContent(xAccounts, state, lookbackHours, isFirstRun, errors) {
  const results = [];
  const cutoffDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  // Create a Rettiwt instance in guest mode — no API key, no login
  const rettiwt = new Rettiwt();

  for (const account of xAccounts) {
    try {
      // Step 1: Get the user's numeric ID (required for timeline fetch)
      const userDetails = await rettiwt.user.details(account.handle);
      if (!userDetails || !userDetails.id) {
        errors.push(`Could not find X user @${account.handle} — handle may have changed`);
        continue;
      }

      // Step 2: Fetch their recent tweets (20 max per request)
      // On first run, only grab 5 tweets per user for the welcome digest
      const count = isFirstRun ? 5 : 20;
      const timeline = await rettiwt.user.timeline(userDetails.id, count);

      if (!timeline || !timeline.list || timeline.list.length === 0) {
        continue;
      }

      // Step 3: Filter tweets — only new ones within our lookback window
      const newTweets = [];
      for (const tweet of timeline.list) {
        const tweetId = tweet.id;
        if (!tweetId) continue;

        // Skip already-processed tweets
        if (state.processedTweets[tweetId]) continue;

        // Skip tweets older than our lookback window
        const tweetDate = new Date(tweet.createdAt);
        if (tweetDate < cutoffDate) continue;

        newTweets.push({
          id: tweetId,
          text: tweet.fullText || '',
          createdAt: tweet.createdAt,
          url: `https://x.com/${account.handle}/status/${tweetId}`,
          likes: tweet.likeCount || 0,
          retweets: tweet.retweetCount || 0,
          replies: tweet.replyCount || 0,
          // Include quoted tweet text if this is a quote tweet
          quotedTweet: tweet.quoted ? {
            text: tweet.quoted.fullText || '',
            author: tweet.quoted.tweetBy?.userName || ''
          } : null,
          // Include media URLs if present
          media: tweet.media ? tweet.media.map(m => m.url) : []
        });

        // Mark as processed
        state.processedTweets[tweetId] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        tweets: newTweets.sort((a, b) =>
          new Date(b.createdAt) - new Date(a.createdAt)
        )
      });

      // Small delay between users to respect rate limits
      // Twitter's internal API has dynamic limits, so we're cautious
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      errors.push(`Error fetching @${account.handle}: ${err.message}`);
      // Continue to next account — partial results are better than none
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Parse command-line args
  const args = process.argv.slice(2);
  const lookbackIdx = args.indexOf('--lookback-hours');
  const lookbackHours = lookbackIdx !== -1
    ? parseInt(args[lookbackIdx + 1], 10)
    : DEFAULT_LOOKBACK_HOURS;

  // Ensure user directory exists
  if (!existsSync(USER_DIR)) {
    await mkdir(USER_DIR, { recursive: true });
  }

  // Load environment variables from user's .env file
  loadEnv({ path: ENV_PATH });

  const supadataKey = process.env.SUPADATA_API_KEY;

  if (!supadataKey) {
    console.error(JSON.stringify({
      error: 'SUPADATA_API_KEY not found',
      message: 'Please add your Supadata API key to ~/.follow-builders/.env'
    }));
    process.exit(1);
  }

  // Load config and state
  const config = await loadConfig();

  // Acquire lock on state file to prevent concurrent corruption
  let releaseLock;
  try {
    // Create state file if it doesn't exist (lockfile needs the file to exist)
    if (!existsSync(STATE_PATH)) {
      await writeFile(STATE_PATH, JSON.stringify({
        processedVideos: {},
        processedTweets: {},
        lastUpdated: null
      }, null, 2));
    }
    releaseLock = await lockfile.lock(STATE_PATH, { retries: 3 });
  } catch (err) {
    console.error(JSON.stringify({
      error: 'STATE_LOCKED',
      message: 'Another fetch is already running. Try again in a few minutes.'
    }));
    process.exit(1);
  }

  try {
    const state = await loadState();

    // Detect first run (welcome digest) — if we've never processed anything
    const isFirstRun = !state.lastUpdated;

    // Collect all errors in an array so they appear in the JSON output
    // instead of stderr — this makes the output much easier for any model
    // to parse, since they only need to read one clean JSON blob
    const errors = [];

    // Fetch content from both sources
    // Note: we run these sequentially rather than in parallel to avoid
    // state mutation issues — both functions write to the same state object
    const podcastContent = await fetchYouTubeContent(
      config.podcasts, state, supadataKey, isFirstRun, errors, lookbackHours
    );
    const xContent = await fetchXContent(
      config.xAccounts, state, lookbackHours, isFirstRun, errors
    );

    // Save updated state (with new processed IDs)
    await saveState(state);

    // Output the combined results as JSON to stdout
    // The agent will read this and remix it into a digest
    const output = {
      status: 'ok',
      fetchedAt: new Date().toISOString(),
      lookbackHours,
      podcasts: podcastContent,
      x: xContent,
      stats: {
        newPodcastEpisodes: podcastContent.length,
        newXBuilders: xContent.length,
        totalNewTweets: xContent.reduce((sum, a) => sum + a.tweets.length, 0)
      },
      // Any errors that occurred during fetching — these are non-fatal,
      // the digest should still be generated from whatever content was fetched
      errors: errors.length > 0 ? errors : undefined
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    // Always release the lock, even if something went wrong
    if (releaseLock) await releaseLock();
  }
}

main().catch(err => {
  console.error(JSON.stringify({
    error: 'FETCH_FAILED',
    message: err.message
  }));
  process.exit(1);
});
