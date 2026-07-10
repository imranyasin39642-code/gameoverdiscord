/**
 * streamer.js — Discord Live Cinema Streamer
 * Uses raw child_process FFmpeg → pipes directly to discord-video-stream
 * packet senders, bypassing node-av entirely (which crashes on Ubuntu VPS).
 *
 * Launch: node streamer.js <guildId> <channelId> <absoluteMoviePath>
 */

// ─── Polyfills (MUST be first) ───────────────────────────────────────────────
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// WebSocket polyfill — required for Node.js v20 (no native global WebSocket)
const ws = require('ws');
global.WebSocket = ws;

// ─── Core imports ─────────────────────────────────────────────────────────────
import { Client } from 'discord.js-selfbot-v13';
import { Streamer, Utils } from '@dank074/discord-video-stream';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import path from 'path';
import fs from 'fs';

// ─── Validate Environment ─────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_STREAMER_TOKEN;
if (!TOKEN) {
    console.error('[Streamer] FATAL: DISCORD_STREAMER_TOKEN env var not set.');
    process.exit(1);
}

const [,, GUILD_ID, CHANNEL_ID, MOVIE_PATH] = process.argv;
if (!GUILD_ID || !CHANNEL_ID || !MOVIE_PATH) {
    console.error('[Streamer] Usage: node streamer.js <guildId> <channelId> <moviePath>');
    process.exit(1);
}
if (!fs.existsSync(MOVIE_PATH)) {
    console.error(`[Streamer] File not found: ${MOVIE_PATH}`);
    process.exit(1);
}

// ─── Stream Config ────────────────────────────────────────────────────────────
const VIDEO_WIDTH   = 1280;
const VIDEO_HEIGHT  = 720;
const VIDEO_FPS     = 30;
const VIDEO_KBPS    = 2500;   // kbps — safe for most Discord connections
const AUDIO_KBPS    = 128;    // kbps

// ─── Discord Client Setup ─────────────────────────────────────────────────────
const client   = new Client({ checkUpdate: false });
const streamer = new Streamer(client);

client.on('ready', async () => {
    console.log(`[Streamer] Logged in as: ${client.user.tag}`);

    try {
        // 1. Join voice channel
        await streamer.joinVoice(GUILD_ID, CHANNEL_ID);
        console.log('[Streamer] Joined voice channel.');

        // 2. Tell Discord we are starting a Go-Live stream
        const udp = await streamer.createStream();
        console.log('[Streamer] Stream session created — starting FFmpeg…');

        // 3. Spawn our own FFmpeg process.
        //    We output in NUT container (same format the library uses internally),
        //    but WE control the spawn so node-av never touches the file.
        //
        //    Key flags:
        //      -re              → read at native framerate (prevents frame=0 stall)
        //      -c:v libx264     → encode with software x264
        //      -preset veryfast → fast enough for real-time
        //      -tune zerolatency→ minimal buffering / latency
        //      -pix_fmt yuv420p → required for Discord H264 WebRTC
        //      -bf 0            → disable B-frames (WebRTC doesn't support them)
        //      -c:a libopus     → Opus audio (Discord native)
        //      -b:v / -b:a      → explicit bitrates
        //      -f nut           → NUT container → stdout pipe
        const ffmpeg = spawn('ffmpeg', [
            '-loglevel', 'warning',
            '-re',
            '-i', MOVIE_PATH,
            // Video stream
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-vf', `scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:force_original_aspect_ratio=decrease,pad=${VIDEO_WIDTH}:${VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
            '-r', String(VIDEO_FPS),
            '-g', String(VIDEO_FPS * 2),   // keyframe every 2 s
            '-bf', '0',
            '-b:v', `${VIDEO_KBPS}k`,
            '-maxrate', `${VIDEO_KBPS * 1.5}k`,
            '-bufsize', `${VIDEO_KBPS * 2}k`,
            // Audio stream
            '-c:a', 'libopus',
            '-b:a', `${AUDIO_KBPS}k`,
            '-ar', '48000',
            '-ac', '2',
            // Output
            '-f', 'nut',
            'pipe:1'
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Log FFmpeg warnings/errors without crashing on them
        ffmpeg.stderr.on('data', (data) => {
            const line = data.toString().trim();
            if (line) console.warn(`[FFmpeg] ${line}`);
        });

        ffmpeg.on('error', (err) => {
            console.error('[FFmpeg] Process spawn error:', err.message);
            streamer.stopStream();
            process.exit(1);
        });

        ffmpeg.on('exit', (code, signal) => {
            console.log(`[FFmpeg] Exited — code=${code} signal=${signal}`);
            streamer.stopStream();
            setTimeout(() => process.exit(0), 500);
        });

        // 4. Pipe FFmpeg stdout (NUT stream) directly into the library's udp stream.
        //    Utils.demuxProbe reads the NUT container and sends H264/Opus packets.
        console.log(`[Streamer] Piping stream: ${path.basename(MOVIE_PATH)}`);

        await Utils.demuxProbe(ffmpeg.stdout).then(async (info) => {
            console.log(`[Streamer] Demux probe OK — video=${info.video} audio=${info.audio}`);
            await Utils.playStream(info, udp, { highWaterMark: 1024 * 1024 });
        });

        console.log('[Streamer] Playback complete. Exiting.');
        process.exit(0);

    } catch (err) {
        console.error('[Streamer] Fatal error:', err);
        process.exit(1);
    }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
const shutdown = (sig) => {
    console.log(`[Streamer] Received ${sig} — shutting down.`);
    try { streamer.stopStream(); } catch (_) {}
    client.destroy();
    process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
