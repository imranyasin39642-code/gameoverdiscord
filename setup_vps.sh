#!/bin/bash
# setup_vps.sh — Run this ONCE on VPS to fix node-av native module
# Usage: bash setup_vps.sh

set -e

echo "==================================================="
echo "  Discord Live Cinema — VPS Setup & Repair Script"
echo "==================================================="

cd /root/gameoverdiscord

# 1. Ensure build tools and FFmpeg 7.x dev libraries are installed
echo ""
echo "[1/4] Installing build dependencies and FFmpeg 7.x dev libraries..."
apt-get update -qq
apt-get install -y -qq software-properties-common
add-apt-repository -y ppa:ubuntuhandbook1/ffmpeg7
apt-get update -qq
apt-get install -y -qq build-essential python3 make g++ ffmpeg libavcodec-dev libavformat-dev libavutil-dev libavfilter-dev libswresample-dev libswscale-dev libavdevice-dev libpostproc-dev

# 2. Rebuild node-av from source.
#    Since node-av npm packages omit binding.gyp (prebuilt only), we must download
#    the source code for the exact matching version from GitHub, place it in node_modules,
#    and compile it against system FFmpeg 7 development headers.
echo ""
echo "[2/4] Downloading node-av source code and building from source..."
npm install

VERSION=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('node_modules/node-av/package.json', 'utf8')).version); } catch(e) { console.log(''); }")

if [ -z "$VERSION" ]; then
  echo "Could not find node-av version in package.json. Attempting direct GitHub install..."
  npm install github:seydx/node-av --build-from-source
else
  echo "Found node-av version: $VERSION"
  echo "Downloading tarball from GitHub..."
  # Try downloading v$VERSION or $VERSION from github
  if wget -q --spider "https://github.com/seydx/node-av/archive/refs/tags/v${VERSION}.tar.gz"; then
    TAR_URL="https://github.com/seydx/node-av/archive/refs/tags/v${VERSION}.tar.gz"
  else
    TAR_URL="https://github.com/seydx/node-av/archive/refs/tags/${VERSION}.tar.gz"
  fi
  
  wget -qO node-av.tar.gz "$TAR_URL"
  
  echo "Extracting source files to node_modules/node-av..."
  mkdir -p node-av-src
  tar -xzf node-av.tar.gz -C node-av-src --strip-components=1
  
  # Remove the prebuilt node-av directory and put the source package in place
  rm -rf node_modules/node-av
  mv node-av-src node_modules/node-av
  rm -f node-av.tar.gz
  
  echo "Compiling node-av against system FFmpeg 7 libraries..."
  npm rebuild node-av --build-from-source
fi
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
