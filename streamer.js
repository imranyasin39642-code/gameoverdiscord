/**
 * streamer.js — Discord Live Cinema
 * =============================================================
 * LIBRARY: discord-stream-client v1.4.8 (NO node-av, NO node-datachannel)
 * 
 * ARCHITECTURE:
 *   1. discord-stream-client joins voice + creates Go-Live UDP connection
 *   2. discord-stream-client's Player handles FFmpeg internally
 *   3. File path is passed directly to Player.playStream()
 *
 * REQUIREMENT: VPS must allow outbound UDP on ports 50000-65535
 *   Run: ufw allow out proto udp && ufw reload
 * =============================================================
 */

'use strict';

// ─── WebSocket Polyfill (required for Node.js v20) ────────────────────────────
const ws = require('ws');
global.WebSocket = ws;

// ─── Core Imports ─────────────────────────────────────────────────────────────
const { Client }              = require('discord.js-selfbot-v13');
const { DiscordStreamClient } = require('discord-stream-client');
const path                    = require('path');
const fs                      = require('fs');

// ─── Read environment / args ──────────────────────────────────────────────────
const TOKEN      = process.env.DISCORD_STREAMER_TOKEN;
const [,, GUILD_ID, CHANNEL_ID, MOVIE_PATH] = process.argv;

if (!TOKEN)      { console.error('[Streamer] FATAL: DISCORD_STREAMER_TOKEN not set.'); process.exit(1); }
if (!GUILD_ID)   { console.error('[Streamer] FATAL: guildId argument missing.');        process.exit(1); }
if (!CHANNEL_ID) { console.error('[Streamer] FATAL: channelId argument missing.');       process.exit(1); }
if (!MOVIE_PATH) { console.error('[Streamer] FATAL: moviePath argument missing.');        process.exit(1); }
if (!fs.existsSync(MOVIE_PATH)) {
    console.error(`[Streamer] FATAL: File not found: ${MOVIE_PATH}`);
    process.exit(1);
}

console.log(`[Streamer] ============================================`);
console.log(`[Streamer] Discord Live Cinema — Node.js Streamer`);
console.log(`[Streamer] Guild:   ${GUILD_ID}`);
console.log(`[Streamer] Channel: ${CHANNEL_ID}`);
console.log(`[Streamer] File:    ${path.basename(MOVIE_PATH)}`);
console.log(`[Streamer] ============================================`);

// ─── Discord client setup ─────────────────────────────────────────────────────
const client = new Client({ checkUpdate: false });
let streamClient = null;
let isShuttingDown = false;

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(reason, code = 0) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Streamer] Shutting down — reason: ${reason}`);

    try {
        if (streamClient) {
            streamClient.destroy();
            streamClient = null;
        }
    } catch (_) {}

    try { client.destroy(); } catch (_) {}

    setTimeout(() => process.exit(code), 800);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error(`[Streamer] Uncaught exception: ${err.message}`);

    // ── Timeout diagnosis (UDP firewall issue) ──────────────────────────────
    if (err.message && err.message.toLowerCase().includes('timeout')) {
        console.error('');
        console.error('[Streamer] ══════════════════════════════════════════');
        console.error('[Streamer] DIAGNOSIS: Voice/Stream UDP handshake timed out.');
        console.error('[Streamer] MOST LIKELY CAUSE: VPS firewall blocking UDP.');
        console.error('[Streamer] FIX — Run these on your VPS RIGHT NOW:');
        console.error('[Streamer]   ufw allow out proto udp');
        console.error('[Streamer]   ufw allow in proto udp');
        console.error('[Streamer]   ufw reload');
        console.error('[Streamer] Then restart bot.py');
        console.error('[Streamer] ══════════════════════════════════════════');
        console.error('');
    }

    shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[Streamer] Unhandled rejection: ${msg}`);
    shutdown('unhandledRejection', 1);
});

// ─── Main streaming logic ──────────────────────────────────────────────────────
client.on('ready', async () => {
    console.log(`[Streamer] Logged in as: ${client.user.tag}`);

    try {
        // 1. Resolve guild and channel
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) throw new Error(`Guild ${GUILD_ID} not found in cache`);

        const channel = guild.channels.cache.get(CHANNEL_ID);
        if (!channel) throw new Error(`Channel ${CHANNEL_ID} not found in cache`);

        if (!channel.isVoice()) throw new Error(`Channel ${CHANNEL_ID} is not a voice channel`);

        console.log(`[Streamer] Target voice channel: ${channel.name} (${channel.id})`);

        // 2. Create the stream client
        streamClient = new DiscordStreamClient(client);

        // 3. Join the voice channel
        //    NOTE: If this times out → run "ufw allow out proto udp" on VPS
        console.log(`[Streamer] Joining voice channel (requires outbound UDP)...`);
        await streamClient.joinVoiceChannel(channel, {
            selfDeaf: false,
            selfMute: false
        });
        console.log(`[Streamer] ✓ Voice connection established!`);

        // 4. Create the Go-Live stream connection
        //    NOTE: If this times out → run "ufw allow out proto udp" on VPS
        console.log(`[Streamer] Creating Go-Live stream (requires outbound UDP)...`);
        const streamConnection = await streamClient.createStream({
            resolution: '720p',   // '480p' | '720p' | '1080p' | '1440p' | 'auto'
            codec: 'H264',        // 'H264' | 'VP8'
            fps: 30               // frames per second
        });
        console.log(`[Streamer] ✓ Go-Live stream created!`);

        // 5. Get the Player (handles FFmpeg transcoding internally)
        const player = streamConnection.getPlayer();

        player.on('finish', () => {
            console.log(`[Streamer] ✓ Playback finished successfully.`);
            shutdown('playback-complete', 0);
        });

        player.on('error', (err) => {
            console.error(`[Streamer] Player error: ${err.message || err}`);
            shutdown('player-error', 1);
        });

        // 6. Start playback — pass file path directly.
        //    discord-stream-client uses fluent-ffmpeg internally to transcode.
        //    FFmpeg MUST be installed on the VPS: apt install ffmpeg
        console.log(`[Streamer] ▶ Starting playback: ${path.basename(MOVIE_PATH)}`);
        await player.playStream(MOVIE_PATH, {
            fps: 30
        });

        console.log(`[Streamer] Stream is live in ${channel.name}!`);

    } catch (err) {
        const msg = err.message || String(err);
        console.error(`[Streamer] Fatal error during setup: ${msg}`);

        if (msg.toLowerCase().includes('timeout')) {
            console.error('');
            console.error('[Streamer] ══════════════════════════════════════════');
            console.error('[Streamer] DIAGNOSIS: UDP connection timed out.');
            console.error('[Streamer] The selfbot joined the voice channel (gateway OK)');
            console.error('[Streamer] but the voice UDP handshake failed (firewall block).');
            console.error('[Streamer]');
            console.error('[Streamer] FIX — Run these on your VPS:');
            console.error('[Streamer]   ufw allow out proto udp');
            console.error('[Streamer]   ufw allow in proto udp');
            console.error('[Streamer]   ufw reload');
            console.error('[Streamer] ══════════════════════════════════════════');
        }

        shutdown('setup-error', 1);
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────
console.log('[Streamer] Logging in to Discord...');
client.login(TOKEN).catch((err) => {
    console.error(`[Streamer] Login failed: ${err.message}`);
    process.exit(1);
});
