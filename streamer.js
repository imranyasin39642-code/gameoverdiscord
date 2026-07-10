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

const client = new Client({
    checkUpdate: false
});

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
        
        // Initialize Streamer
        const streamer = new Streamer(client);
        await streamer.joinVoice(guildId, channelId);
        
        console.log(`[Streamer] Connected! Initializing high-quality FFmpeg stream for: ${path.basename(moviePath)}`);
        
        // Tuned for absolute best 720p 60fps H264 quality
        const { command, output } = prepareStream(moviePath, {
            videoCodec: 'H264',
            width: 1280,
            height: 720,
            frameRate: 60,
            bitrateVideo: 3500, // 3500 kbps (3.5 Mbps)
            includeAudio: true
        });

        command.on('error', (err) => {
            console.error("[Streamer] FFmpeg rendering pipeline crashed:", err);
            process.exit(1);
        });

        command.on('end', () => {
            console.log("[Streamer] Movie playback completed successfully. Exiting...");
            process.exit(0);
        });
        
        // Start streaming
        await playStream(output, streamer);

        console.log("[Streamer] 🎥 Stream is now live inside voice channel! Press stop/disconnect command to exit.");
        
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
