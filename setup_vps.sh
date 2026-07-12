#!/bin/bash
# setup_vps.sh — Run this ONCE on VPS to fix node-av native module
# Usage: bash setup_vps.sh

set -e

echo "==================================================="
echo "  Discord Live Cinema — VPS Setup & Repair Script"
echo "==================================================="

cd /root/gameoverdiscord

# 1. Purge FFmpeg 7.x PPA and install standard system FFmpeg
echo ""
echo "[1/3] Restoring system FFmpeg..."
apt-get install -y -qq software-properties-common

# Purge PPA and existing FFmpeg 7 packages to avoid conflicts
apt-get purge -y ffmpeg libavcodec-dev libavformat-dev libavutil-dev libavfilter-dev libswresample-dev libswscale-dev libavdevice-dev libpostproc-dev || true
apt-get autoremove -y -qq || true

if apt-cache policy | grep -q "ffmpeg7"; then
  add-apt-repository --remove -y ppa:ubuntuhandbook1/ffmpeg7 || true
fi
apt-get update -qq

# Install standard stable repository FFmpeg
apt-get install -y -qq ffmpeg

# 2. Clean install npm dependencies using prebuilt binaries (NO compilation from source)
echo ""
echo "[2/3] Cleaning node_modules and running clean npm install..."
rm -rf node_modules package-lock.json
npm cache clean --force
npm install

# 3. Verify node-av loads correctly
echo ""
echo "[3/3] Verifying node-av loads..."
node -e "
try {
  const av = require('node-av');
  console.log('✓ node-av loaded successfully.');
} catch(e) {
  console.error('✗ node-av failed to load:', e.message);
  process.exit(1);
}
"

echo ""
echo "==================================================="
echo "  Setup complete! Now run: python bot.py"
echo "==================================================="
