/**
 * streamer.js — Discord Live Cinema
 * Uses @dank074/discord-video-stream + prepareStream + playStream
 *
 * IMPORTANT: If you see "frame extraction error", run setup_vps.sh first!
 * Launch: node streamer.js <guildId> <channelId> <absoluteMoviePath>
 */

// ─── WebSocket polyfill (required for Node.js v20) ───────────────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ws = require('ws');
global.WebSocket = ws;

// ─── Imports ──────────────────────────────────────────────────────────────────
import { Client } from 'discord.js-selfbot-v13';
import { Streamer, prepareStream, playStream } from '@dank074/discord-video-stream';
import path from 'path';
import fs from 'fs';

// ─── Validate ─────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_STREAMER_TOKEN;
if (!TOKEN) { console.error('[Streamer] FATAL: DISCORD_STREAMER_TOKEN not set.'); process.exit(1); }

const [,, GUILD_ID, CHANNEL_ID, MOVIE_PATH] = process.argv;
if (!GUILD_ID || !CHANNEL_ID || !MOVIE_PATH) {
    console.error('[Streamer] Usage: node streamer.js <guildId> <channelId> <moviePath>');
    process.exit(1);
}
if (!fs.existsSync(MOVIE_PATH)) {
    console.error(`[Streamer] File not found: ${MOVIE_PATH}`);
    process.exit(1);
}

// ─── Client ───────────────────────────────────────────────────────────────────
const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

client.on('ready', async () => {
    console.log(`[Streamer] Ready as ${client.user.tag}`);

    try {
        // 1. Join voice channel
        await streamer.joinVoice(GUILD_ID, CHANNEL_ID);
        console.log('[Streamer] Joined voice channel.');

        // 2. Prepare the FFmpeg pipeline via the library.
        //    This transcodes the file using libx264 + libopus into a NUT stream.
        console.log(`[Streamer] Preparing stream: ${path.basename(MOVIE_PATH)}`);
        const { command, output } = prepareStream(MOVIE_PATH, {
            videoCodec:       'H264',
            fps:              30,
            width:            1280,
            height:           720,
            bitrateVideo:     3000,
            bitrateVideoMax:  4500,
            includeAudio:     true,
            bitrateAudioKbps: 128,
            h26xPreset:       'veryfast',
        });

        // Log FFmpeg stderr for debugging
        command.on('stderr', (line) => {
            if (line) console.log(`[FFmpeg] ${line}`);
        });
        command.on('error', (err) => {
            console.error('[FFmpeg] Error:', err.message);
        });

        // 3. Play the stream to Discord
        console.log('[Streamer] Streaming started.');
        await playStream(output, streamer, { type: 'go-live' });

        console.log('[Streamer] Playback finished. Exiting.');
        process.exit(0);

    } catch (err) {
        console.error('[Streamer] Fatal error:', err.message || err);
        process.exit(1);
    }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = () => {
    console.log('[Streamer] Shutting down.');
    try { streamer.stopStream?.(); } catch (_) {}
    client.destroy();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
