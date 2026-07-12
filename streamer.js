/**
 * streamer.js — Discord Live Cinema
 * =============================================================
 * LIBRARY: discord-stream-client (NO node-av, NO node-datachannel)
 * APPROACH: child_process.spawn raw FFmpeg → piped to Player
 *
 * This completely avoids ALL native C++ compilation.
 * Only needs: system ffmpeg + prebuilt @discordjs/opus binaries
 *
 * Usage: node streamer.js <guildId> <channelId> <absoluteMoviePath>
 * =============================================================
 */

'use strict';

// ─── WebSocket Polyfill (required for Node.js v20) ────────────────────────────
const ws = require('ws');
global.WebSocket = ws;

// ─── Core Imports ─────────────────────────────────────────────────────────────
const { Client }              = require('discord.js-selfbot-v13');
const { DiscordStreamClient } = require('discord-stream-client');
const { spawn }               = require('child_process');
const path                    = require('path');
const fs                      = require('fs');

// ─── Read environment / args ──────────────────────────────────────────────────
const TOKEN      = process.env.DISCORD_STREAMER_TOKEN;
const [,, GUILD_ID, CHANNEL_ID, MOVIE_PATH] = process.argv;

if (!TOKEN)       { console.error('[Streamer] FATAL: DISCORD_STREAMER_TOKEN not set.'); process.exit(1); }
if (!GUILD_ID)    { console.error('[Streamer] FATAL: guildId argument missing.');         process.exit(1); }
if (!CHANNEL_ID)  { console.error('[Streamer] FATAL: channelId argument missing.');        process.exit(1); }
if (!MOVIE_PATH)  { console.error('[Streamer] FATAL: moviePath argument missing.');         process.exit(1); }
if (!fs.existsSync(MOVIE_PATH)) {
    console.error(`[Streamer] FATAL: File not found: ${MOVIE_PATH}`);
    process.exit(1);
}

console.log(`[Streamer] Starting up…`);
console.log(`[Streamer] Guild:   ${GUILD_ID}`);
console.log(`[Streamer] Channel: ${CHANNEL_ID}`);
console.log(`[Streamer] File:    ${path.basename(MOVIE_PATH)}`);

// ─── Discord client ───────────────────────────────────────────────────────────
const client = new Client({ checkUpdate: false });

// ─── Graceful shutdown helpers ────────────────────────────────────────────────
let ffmpegProc   = null;
let streamClient = null;

async function shutdown(reason) {
    console.log(`[Streamer] Shutdown triggered: ${reason}`);
    if (ffmpegProc && !ffmpegProc.killed) {
        try { ffmpegProc.kill('SIGKILL'); } catch (_) {}
    }
    if (streamClient) {
        try { streamClient.destroy(); } catch (_) {}
    }
    try { client.destroy(); } catch (_) {}
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('[Streamer] Uncaught exception:', err.message);
    shutdown('uncaughtException');
});

// ─── Main streaming logic ──────────────────────────────────────────────────────
client.on('ready', async () => {
    console.log(`[Streamer] Logged in as ${client.user.tag}`);

    try {
        // 1. Resolve the voice channel
        const guild   = client.guilds.cache.get(GUILD_ID);
        if (!guild)   throw new Error(`Guild ${GUILD_ID} not found.`);
        const channel = guild.channels.cache.get(CHANNEL_ID);
        if (!channel) throw new Error(`Channel ${CHANNEL_ID} not found.`);

        console.log(`[Streamer] Joining voice channel: ${channel.name}`);

        // 2. Create DiscordStreamClient and join voice
        streamClient = new DiscordStreamClient(client);
        await streamClient.joinVoiceChannel(channel);
        console.log('[Streamer] Joined voice channel successfully.');

        // 3. Create the Go-Live stream connection
        const streamConnection = await streamClient.createStream();
        console.log('[Streamer] Go-Live stream connection established.');

        // 4. Get the Player from the stream connection
        const player = streamConnection.getPlayer();

        // 5. Spawn raw FFmpeg → pipe to the Player (NO node-av involved!)
        console.log(`[Streamer] Spawning FFmpeg for: ${path.basename(MOVIE_PATH)}`);

        const ffmpegArgs = [
            '-loglevel', 'warning',
            '-re',                          // real-time input rate
            '-i', MOVIE_PATH,               // input file
            // ── Video output ──────────────────────────────────────────
            '-map', '0:v:0',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
            '-b:v', '3000k',
            '-maxrate', '4500k',
            '-bufsize', '6000k',
            '-g', '60',                     // keyframe every 2s at 30fps
            '-bf', '0',                     // disable B-frames (WebRTC requirement)
            '-r', '30',
            // ── Audio output ──────────────────────────────────────────
            '-map', '0:a:0',
            '-c:a', 'libopus',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '128k',
            // ── Output format ─────────────────────────────────────────
            '-f', 'matroska',               // MKV container — discord-stream-client reads it
            'pipe:1',                        // stdout pipe
        ];

        ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Log FFmpeg stderr for debugging
        ffmpegProc.stderr.on('data', (chunk) => {
            const line = chunk.toString().trim();
            if (line) console.log(`[FFmpeg] ${line}`);
        });

        ffmpegProc.on('error', (err) => {
            console.error('[FFmpeg] Spawn error:', err.message);
            shutdown('ffmpeg-error');
        });

        ffmpegProc.on('exit', (code, signal) => {
            console.log(`[FFmpeg] Process exited — code=${code} signal=${signal}`);
            shutdown('ffmpeg-exit');
        });

        // 6. Pipe FFmpeg stdout directly to the Player
        console.log('[Streamer] Piping FFmpeg stream to Discord Go-Live…');
        await player.playStream(ffmpegProc.stdout);

        console.log('[Streamer] Playback finished. Exiting cleanly.');
        shutdown('playback-complete');

    } catch (err) {
        console.error('[Streamer] Fatal error during setup:', err.message || err);
        shutdown('setup-error');
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────
console.log('[Streamer] Logging in…');
client.login(TOKEN).catch((err) => {
    console.error('[Streamer] Login failed:', err.message);
    process.exit(1);
});
