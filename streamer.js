/**
 * 🎥 Discord Live Cinema — Node.js Stream Worker
 * Negotiates WebRTC voice/video connection and pipes FFmpeg streaming output.
 * Uses discord.js-selfbot-v13 & discord-video-stream packages.
 */

const { Client } = require('discord.js-selfbot-v13');
const { StreamConnection, playStream } = require('discord-video-stream');
const path = require('path');
const fs = require('fs');

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
        
        // Initialize Stream Connection
        const streamConnection = new StreamConnection(client, guildId, channelId);
        await streamConnection.connect();
        
        console.log(`[Streamer] Connected! Initializing high-quality FFmpeg stream for: ${path.basename(moviePath)}`);
        
        // Tuned for absolute best 720p 60fps VP8 quality for a 6-Core beast VPS
        const streamPlay = await playStream(moviePath, streamConnection, {
            ffmpegPath: 'ffmpeg',
            videoCodec: 'VP8',
            width: 1280,
            height: 720,
            fps: 60,
            bitrate: 3500000, // 3.5 Mbps Video Bitrate (crystal-clear 720p)
            ffmpegVideoFlags: [
                '-deadline', 'good',  // High-quality encoding pass (not fast/realtime, VPS can easily afford)
                '-cpu-used', '2',     // Devotes more VPS compression cycles for pristine frames
                '-crf', '12',         // Constant Rate Factor range (Lower = higher quality, 12 is near-lossless)
                '-g', '120'           // Keyframe interval for stable playback streaming
            ],
            ffmpegAudioFlags: [
                '-acodec', 'libopus',
                '-b:a', '192k',       // 192kbps High Fidelity audio
                '-ar', '48000',
                '-ac', '2'
            ]
        });

        streamPlay.on('finish', () => {
            console.log("[Streamer] Movie playback completed successfully. Exiting...");
            process.exit(0);
        });

        streamPlay.on('error', (err) => {
            console.error("[Streamer] FFmpeg rendering pipeline crashed:", err);
            process.exit(1);
        });

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
