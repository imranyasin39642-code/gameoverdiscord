#!/bin/bash
# setup_vps.sh — Run this ONCE on VPS to fix node-av native module
# Usage: bash setup_vps.sh

set -e

echo "==================================================="
echo "  Discord Live Cinema — VPS Setup & Repair Script"
echo "==================================================="

cd /root/gameoverdiscord

# 1. Ensure build tools are installed (needed to compile node-av from source)
echo ""
echo "[1/4] Installing build dependencies..."
apt-get update -qq && apt-get install -y -qq build-essential python3 make g++ ffmpeg

# 2. Rebuild all native Node.js addons (node-av, node-datachannel) from source.
#    This fixes the "frame extraction error" crash caused by prebuilt binaries
#    being compiled for a different Node.js version.
echo ""
echo "[2/4] Rebuilding native Node.js addons from source..."
npm rebuild --build-from-source
echo "✓ Native modules rebuilt."

# 3. Verify node-av loads correctly
echo ""
echo "[3/4] Verifying node-av loads..."
node -e "
try {
  const av = require('node-av');
  console.log('✓ node-av loaded successfully.');
} catch(e) {
  console.error('✗ node-av STILL failing:', e.message);
  process.exit(1);
}
"

# 4. Verify ffmpeg is available
echo ""
echo "[4/4] Verifying ffmpeg..."
ffmpeg -version | head -n 1
echo "✓ ffmpeg is available."

echo ""
echo "==================================================="
echo "  Setup complete! Now run: python bot.py"
echo "==================================================="
