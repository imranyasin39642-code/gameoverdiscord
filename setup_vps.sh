#!/bin/bash
# setup_vps.sh — Run this ONCE on VPS to set up or repair the streamer
# Usage: bash setup_vps.sh

set -e

echo "==================================================="
echo "  Discord Live Cinema — VPS Setup Script"
echo "  (Zero native C++ compilation required)"
echo "==================================================="

cd /root/gameoverdiscord

# ── Step 1: Fix VPS Firewall (CRITICAL — Discord voice needs outbound UDP) ────
echo ""
echo "[1/4] Configuring UFW firewall for Discord voice UDP..."
echo "      (Without this, voice joins timeout after 15-20 seconds)"

# Allow outbound UDP (Discord voice servers use high UDP ports 50000-65535)
ufw allow out proto udp 2>/dev/null  && echo "      ✓ Outbound UDP allowed" || echo "      (ufw not active — skipping)"

# Allow inbound UDP responses from Discord voice servers
ufw allow in proto udp 2>/dev/null   && echo "      ✓ Inbound UDP allowed"  || echo "      (ufw not active — skipping)"

# Reload firewall
ufw reload 2>/dev/null               && echo "      ✓ Firewall reloaded"    || echo "      (ufw not active — skipping)"

echo "  ✓ Firewall configured."

# ── Step 2: Install system FFmpeg (binary, no dev headers needed) ─────────────
echo ""
echo "[2/4] Installing/verifying system FFmpeg..."
apt-get update -qq
apt-get install -y -qq ffmpeg
FFVER=$(ffmpeg -version 2>&1 | head -n 1)
echo "  ✓ $FFVER"

# ── Step 3: Clean npm install (prebuilt binaries only, NO C++ compilation) ────
echo ""
echo "[3/4] Running clean npm install (prebuilt binaries only)..."
rm -rf node_modules package-lock.json
npm cache clean --force
npm install --prefer-offline 2>/dev/null || npm install
echo "  ✓ npm install complete."

# ── Step 3.5: Ensure voice encryption modules are present ─────────────────────
# discord-stream-client requires at least ONE of: sodium, libsodium-wrappers, tweetnacl
# Without these it throws MISSING_ENCRYPTION_MODULE at require-time.
echo ""
echo "[3.5] Installing voice encryption modules (libsodium-wrappers + tweetnacl)..."
npm install libsodium-wrappers@latest tweetnacl@latest
echo "  ✓ Encryption modules installed."

# ── Step 4: Verify discord-stream-client loads ────────────────────────────────
echo ""
echo "[4/4] Verifying discord-stream-client loads correctly..."
node -e "
try {
  const m = require('discord-stream-client');
  if (m.DiscordStreamClient && m.Player) {
    console.log('  ✓ discord-stream-client loaded — DiscordStreamClient + Player found.');
  } else {
    const missing = [];
    if (!m.DiscordStreamClient) missing.push('DiscordStreamClient');
    if (!m.Player) missing.push('Player');
    console.error('  ✗ Missing exports: ' + missing.join(', '));
    process.exit(1);
  }
} catch (e) {
  console.error('  ✗ discord-stream-client failed to load:', e.message);
  process.exit(1);
}
"

echo ""
echo "==================================================="
echo "  Setup complete!"
echo ""
echo "  IMPORTANT: If you still get 'Timeout' errors:"
echo "  1. Check UFW status: ufw status verbose"
echo "  2. Ensure UDP is allowed: ufw allow out proto udp"
echo "  3. Try: nc -u -z 8.8.8.8 53  (test outbound UDP)"
echo ""
echo "  Now run: python bot.py"
echo "==================================================="
