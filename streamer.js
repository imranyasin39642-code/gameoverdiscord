import { File } from 'node:buffer';
global.File = File;

import WebSocket from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'discord.js-selfbot-v13';
import { Streamer, prepareStream, playStream } from '@dank074/discord-video-stream';
import path from 'path';
import fs from 'fs';

// Verify token presence
const token = process.env.DISCORD_STREAMER_TOKEN;
if (!token) {
    console.error("[Streamer] Error: DISCORD_STREAMER_TOKEN environment variable not set!");
    process.exit(1);
}

const client = new Client({ checkUpdate: false });

// Read CLI parameters
const guildId = process.argv[2];
const channelId = process.argv[3];
const moviePath = process.argv[4];

if (!guildId || !channelId || !moviePath) {
    console.error("[Streamer] Usage: node streamer.js <guildId> <channelId> <moviePath>");
    process.exit(1);
}

if (!fs.existsSync(moviePath)) {
    console.error(`[Streamer] Error: Movie file not found: ${moviePath}`);
    process.exit(1);
}

client.on('ready', async () => {
    console.log(`[Streamer] Logged in successfully as user client: ${client.user.tag}`);

    try {
        console.log(`[Streamer] Attempting to connect to Guild: ${guildId}, Voice Channel: ${channelId}...`);

        const streamer = new Streamer(client);
        await streamer.joinVoice(guildId, channelId);

        console.log(`[Streamer] Connected! Preparing FFmpeg pipeline for: ${path.basename(moviePath)}`);

        // Use prepareStream so FFmpeg itself handles decoding the local file.
        // This bypasses the broken node-av internal demuxer path and runs ffmpeg
        // directly, ensuring video frames are actually produced.
        const { command, output } = prepareStream(moviePath, {
            videoCodec: 'H264',
            width: 1280,
            height: 720,
            frameRate: 30,
            bitrateVideo: 3000,   // 3000 kbps
            includeAudio: true,
            // Force pixel format and read at native rate via ffmpegOptions
            ffmpegOptions: [
                '-re',            // Read input at native framerate (prevents frame=0 stall)
                '-pix_fmt', 'yuv420p',  // Force yuv420p for H264 compatibility
            ]
        });

        command.on('stderr', (line) => {
            console.warn(`[FFmpeg] ${line}`);
        });

        command.on('error', (err) => {
            console.error("[Streamer] FFmpeg pipeline crashed:", err.message);
            process.exit(1);
        });

        command.on('end', () => {
            console.log("[Streamer] FFmpeg pipeline finished.");
        });

        console.log(`[Streamer] Streaming now: ${path.basename(moviePath)}`);

        // playStream sends the FFmpeg-piped output to the Discord voice channel.
        // 'streamer' is the Streamer instance (not udp).
        await playStream(output, streamer, {
            type: 'go-live',
        });

        console.log("[Streamer] Movie playback completed successfully. Exiting...");
        process.exit(0);

    } catch (err) {
        console.error("[Streamer] Failed to join or stream to channel:", err);
        process.exit(1);
    }
});

// Trap termination signals to gracefully disconnect
const handleExit = () => {
    console.log("[Streamer] Shutting down connection...");
    client.destroy();
    process.exit(0);
};

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);

// Connect to Discord Gateway
client.login(token);
