/**
 * streamer.js — Discord Live Cinema
 * ============================================================
 * LIBRARY : discord-stream-client (zero node-av/node-datachannel)
 * CRITICAL: libsodium-wrappers WASM must be awaited before
 *           ANY voice operation or the crypto handshake fails.
 * ============================================================
 */

'use strict';

// ── PRE-INIT: Require encryption modules NOW (before any discord import) ──────
// libsodium-wrappers is WebAssembly — needs explicit await sodium.ready
// tweetnacl is pure-JS fallback — no init needed
const sodium = require('libsodium-wrappers');
require('tweetnacl');

// ── WebSocket polyfill (Node.js v20 requirement) ───────────────────────────────
const ws = require('ws');
global.WebSocket = ws;

// ── Core imports ───────────────────────────────────────────────────────────────
const { Client }              = require('discord.js-selfbot-v13');
const { DiscordStreamClient } = require('discord-stream-client');
const path                    = require('path');
const fs                      = require('fs');

// ── Args + env ─────────────────────────────────────────────────────────────────
const TOKEN      = process.env.DISCORD_STREAMER_TOKEN;
const [,, GUILD_ID, CHANNEL_ID, MOVIE_PATH] = process.argv;

if (!TOKEN)      { console.error('[Streamer] FATAL: DISCORD_STREAMER_TOKEN not set.'); process.exit(1); }
if (!GUILD_ID)   { console.error('[Streamer] FATAL: guildId missing.');                 process.exit(1); }
if (!CHANNEL_ID) { console.error('[Streamer] FATAL: channelId missing.');                process.exit(1); }
if (!MOVIE_PATH) { console.error('[Streamer] FATAL: moviePath missing.');                process.exit(1); }
if (!fs.existsSync(MOVIE_PATH)) {
    console.error(`[Streamer] FATAL: File not found: ${MOVIE_PATH}`);
    process.exit(1);
}

console.log(`[Streamer] =============================================`);
console.log(`[Streamer] Discord Live Cinema — Node Streamer`);
console.log(`[Streamer] Guild:   ${GUILD_ID}`);
console.log(`[Streamer] Channel: ${CHANNEL_ID}`);
console.log(`[Streamer] File:    ${path.basename(MOVIE_PATH)}`);
console.log(`[Streamer] =============================================`);

// ── Discord client ─────────────────────────────────────────────────────────────
const client = new Client({ checkUpdate: false });
let streamClient    = null;
let isShuttingDown  = false;

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(reason, code = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Streamer] Shutdown — reason: ${reason}`);
    try { if (streamClient) streamClient.destroy(); } catch (_) {}
    try { client.destroy(); } catch (_) {}
    setTimeout(() => process.exit(code), 800);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { console.error(`[Streamer] Uncaught:  ${err.message}`); shutdown('uncaughtException',  1); });
process.on('unhandledRejection', (r)   => { console.error(`[Streamer] Rejection: ${r instanceof Error ? r.message : r}`); shutdown('unhandledRejection', 1); });

// ── Helpers ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Attempt to join a voice channel, retrying up to `maxAttempts` times.
 * A FRESH DiscordStreamClient is created on every attempt — stale internal
 * state from a failed attempt would otherwise block the next one.
 */
async function joinVoiceWithRetry(channel, maxAttempts = 3) {
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Destroy any previous instance
        if (streamClient) {
            try { streamClient.destroy(); } catch (_) {}
            streamClient = null;
        }

        // Fresh instance — registers its own gateway listeners cleanly
        streamClient = new DiscordStreamClient(client);

        try {
            console.log(`[Streamer] Voice join attempt ${attempt}/${maxAttempts}...`);
            await streamClient.joinVoiceChannel(channel, {
                selfDeaf: false,
                selfMute: false
            });
            console.log(`[Streamer] ✓ Voice connected! (attempt ${attempt})`);
            return; // success
        } catch (err) {
            lastErr = err;
            console.error(`[Streamer] Attempt ${attempt} failed: ${err.message}`);

            if (attempt < maxAttempts) {
                const wait = attempt * 4000; // 4 s, 8 s …
                console.log(`[Streamer] Waiting ${wait / 1000}s before retry...`);
                await sleep(wait);
            }
        }
    }

    throw lastErr ?? new Error('Voice join failed after all retries');
}

// ── Main logic (runs after Discord login) ─────────────────────────────────────
client.on('ready', async () => {
    console.log(`[Streamer] Logged in as: ${client.user.tag}`);

    try {
        // ── Step 1: Await sodium WASM initialisation ─────────────────────────
        // libsodium-wrappers is a WebAssembly module. Calling crypto functions
        // before this resolves causes silent failures during the voice handshake.
        console.log('[Streamer] Awaiting libsodium-wrappers WASM init...');
        await sodium.ready;
        console.log('[Streamer] ✓ libsodium-wrappers ready.');

        // ── Step 2: Resolve guild + channel ─────────────────────────────────
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) throw new Error(`Guild ${GUILD_ID} not found in cache`);

        const channel = guild.channels.cache.get(CHANNEL_ID);
        if (!channel) throw new Error(`Channel ${CHANNEL_ID} not found in cache`);
        if (!channel.isVoice()) throw new Error(`Channel ${CHANNEL_ID} is not a voice channel`);

        console.log(`[Streamer] Target: "${channel.name}" (${channel.id})`);

        // ── Step 3: Join voice (with retry) ─────────────────────────────────
        await joinVoiceWithRetry(channel, 3);

        // ── Step 4: Create Go-Live stream ────────────────────────────────────
        console.log('[Streamer] Creating Go-Live stream...');
        const streamConnection = await streamClient.createStream({
            resolution : '720p',   // '480p' | '720p' | '1080p' | '1440p' | 'auto'
            codec      : 'H264',   // 'H264' | 'VP8'
            fps        : 30
        });
        console.log('[Streamer] ✓ Go-Live stream established!');

        // ── Step 5: Play via built-in Player (FFmpeg handled internally) ─────
        const player = streamConnection.getPlayer();

        player.on('finish', () => {
            console.log('[Streamer] ✓ Playback finished.');
            shutdown('playback-complete', 0);
        });

        player.on('error', (err) => {
            console.error(`[Streamer] Player error: ${err.message || err}`);
            shutdown('player-error', 1);
        });

        console.log(`[Streamer] ▶ Playback started: ${path.basename(MOVIE_PATH)}`);
        await player.playStream(MOVIE_PATH, { fps: 30 });
        console.log('[Streamer] Stream is live!');

    } catch (err) {
        console.error(`[Streamer] Fatal setup error: ${err.message || err}`);
        shutdown('setup-error', 1);
    }
});

// ── Login ─────────────────────────────────────────────────────────────────────
console.log('[Streamer] Logging in...');
client.login(TOKEN).catch((err) => {
    console.error(`[Streamer] Login failed: ${err.message}`);
    process.exit(1);
});
