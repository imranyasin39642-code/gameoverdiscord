import { File } from 'node:buffer';
global.File = File;

import WebSocket from 'ws';
global.WebSocket = WebSocket;

import { Client } from 'discord.js-selfbot-v13';
import { Streamer, Encoders, playStream } from '@dank074/discord-video-stream';
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
        
        console.log(`[Streamer] Connected! Creating Stream Connection...`);
        const udp = await streamer.createStream();
        
        // Prepare speaking/video states
        udp.mediaConnection.setSpeaking(true);
        udp.mediaConnection.setVideoStatus(true);
        
        console.log(`[Streamer] Connected! Initializing stream for: ${path.basename(moviePath)}`);
        
        // Play local file using software x264 encoder
        await playStream(moviePath, udp, Encoders.software({
            x264: {
                preset: 'faster', // Balanced preset for high quality and minimal VPS load
            }
        }));

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
