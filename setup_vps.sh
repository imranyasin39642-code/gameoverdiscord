#!/bin/bash
# setup_vps.sh — Run this ONCE on VPS
# Installs system ffmpeg + does clean npm install (prebuilt binaries only, NO compilation)
# Usage: bash setup_vps.sh

set -e

echo "==================================================="
echo "  Discord Live Cinema — VPS Setup Script"
echo "  (Zero native C++ compilation required)"
echo "==================================================="

cd /root/gameoverdiscord

# ── Step 1: Install system FFmpeg (binary, no dev headers needed) ─────────────
echo ""
echo "[1/3] Installing system FFmpeg..."
apt-get update -qq
apt-get install -y -qq ffmpeg
ffmpeg -version | head -n 1
echo "✓ FFmpeg installed."

# ── Step 2: Clean npm install (downloads prebuilt binaries, NO build-from-source) ──
echo ""
echo "[2/3] Running clean npm install (prebuilt binaries only)..."
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
echo "✓ npm install complete."

# ── Step 3: Verify discord-stream-client loads ────────────────────────────────
echo ""
echo "[3/3] Verifying discord-stream-client loads correctly..."
node -e "
try {
  const m = require('discord-stream-client');
  if (m.DiscordStreamClient) {
    console.log('✓ discord-stream-client loaded — DiscordStreamClient class found.');
  } else {
    console.error('✗ discord-stream-client loaded but DiscordStreamClient class missing.');
    process.exit(1);
  }
} catch (e) {
  console.error('✗ discord-stream-client failed to load:', e.message);
  process.exit(1);
}
"

echo ""
echo "==================================================="
echo "  Setup complete! Now run: python bot.py"
echo "==================================================="
