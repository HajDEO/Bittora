#!/bin/bash
set -e

# Bittora Installer
# Usage: sudo bash install.sh

BITTORA_DIR="/opt/bittora"
BITTORA_USER="bittora"
BITTORA_GROUP="bittora"
CONFIG_FILE="$BITTORA_DIR/config.json"
SERVICE_FILE="/etc/systemd/system/bittora.service"
SUDOERS_FILE="/etc/sudoers.d/bittora"
MOUNT_BASE="/mnt/bittora"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# ── Check root ──────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    err "Please run as root: sudo bash install.sh"
fi

# ── Detect mode ─────────────────────────────────────────────────────
if [ -f "$BITTORA_DIR/backend/main.py" ]; then
    MODE="update"
    info "Existing installation detected — running UPDATE"
else
    MODE="fresh"
    info "No existing installation — running FRESH INSTALL"
fi

echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  Bittora Installer (${MODE})${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# ════════════════════════════════════════════════════════════════════
# UPDATE MODE
# ════════════════════════════════════════════════════════════════════
if [ "$MODE" = "update" ]; then
    log "Pulling latest code..."
    cd "$BITTORA_DIR"
    git fetch origin
    git reset --hard origin/main

    log "Installing Python dependencies..."
    pip3 install -q -r requirements.txt 2>/dev/null || pip install -q -r requirements.txt

    log "Building frontend..."
    cd "$BITTORA_DIR/frontend"
    npm install --silent
    npm run build

    log "Setting permissions..."
    chown -R "$BITTORA_USER:$BITTORA_GROUP" "$BITTORA_DIR"

    log "Updating systemd service..."
    cp "$BITTORA_DIR/bittora.service" "$SERVICE_FILE"
    systemctl daemon-reload

    log "Restarting Bittora..."
    systemctl restart bittora

    echo ""
    echo -e "${GREEN}Update complete!${NC}"
    systemctl status bittora --no-pager -l || true
    exit 0
fi

# ════════════════════════════════════════════════════════════════════
# FRESH INSTALL
# ════════════════════════════════════════════════════════════════════

# ── 1. System dependencies ──────────────────────────────────────────
log "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq \
    python3 python3-pip python3-venv python3-libtorrent \
    git curl wget smbclient nfs-common cifs-utils \
    > /dev/null 2>&1

# ── 2. Node.js (if not installed) ──────────────────────────────────
if ! command -v node &> /dev/null; then
    log "Installing Node.js 22.x..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
else
    NODE_VER=$(node -v)
    info "Node.js already installed: $NODE_VER"
fi

# ── 3. Create user ─────────────────────────────────────────────────
if ! id "$BITTORA_USER" &>/dev/null; then
    log "Creating system user '$BITTORA_USER'..."
    useradd -r -s /usr/sbin/nologin -d /opt/bittora "$BITTORA_USER"
else
    info "User '$BITTORA_USER' already exists"
fi

# ── 4. Clone or copy repo ──────────────────────────────────────────
if [ ! -d "$BITTORA_DIR/.git" ]; then
    if [ -d "$BITTORA_DIR" ] && [ "$(ls -A $BITTORA_DIR 2>/dev/null)" ]; then
        warn "$BITTORA_DIR exists and is not empty — using existing files"
    else
        log "Cloning Bittora..."
        git clone https://github.com/HajDEO/Bittora.git "$BITTORA_DIR"
    fi
else
    info "Git repo already present at $BITTORA_DIR"
fi

# ── 5. Python dependencies ─────────────────────────────────────────
log "Installing Python dependencies..."
pip3 install -q -r "$BITTORA_DIR/requirements.txt" 2>/dev/null \
    || pip install -q -r "$BITTORA_DIR/requirements.txt" --break-system-packages

# ── 6. Frontend build ──────────────────────────────────────────────
log "Building frontend..."
cd "$BITTORA_DIR/frontend"
npm install --silent
npm run build

# ── 7. Directories ─────────────────────────────────────────────────
log "Creating directories..."
mkdir -p /srv/bittora/downloads
mkdir -p /var/lib/bittora
mkdir -p /var/log/bittora
mkdir -p "$MOUNT_BASE"

# ── 8. Generate config ─────────────────────────────────────────────
if [ ! -f "$CONFIG_FILE" ]; then
    log "Generating config.json..."
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    cat > "$CONFIG_FILE" <<CONF
{
    "port": 8080,
    "lang": "en",
    "download_dir": "/srv/bittora/downloads",
    "data_dir": "/var/lib/bittora",
    "log_dir": "/var/log/bittora",
    "secret": "$SECRET"
}
CONF
else
    warn "config.json already exists — not overwriting"
fi

# ── 9. Permissions ──────────────────────────────────────────────────
log "Setting permissions..."
chown -R "$BITTORA_USER:$BITTORA_GROUP" "$BITTORA_DIR"
chown -R "$BITTORA_USER:$BITTORA_GROUP" /srv/bittora
chown -R "$BITTORA_USER:$BITTORA_GROUP" /var/lib/bittora
chown -R "$BITTORA_USER:$BITTORA_GROUP" /var/log/bittora
chown "$BITTORA_USER:$BITTORA_GROUP" "$MOUNT_BASE"
chmod +x "$BITTORA_DIR/start.sh"

# ── 10. Sudoers for mount/umount ────────────────────────────────────
log "Configuring sudoers for mount operations..."
cat > "$SUDOERS_FILE" <<'SUDOERS'
# Bittora mount/umount permissions
bittora ALL=(root) NOPASSWD: /usr/bin/mkdir -p /mnt/bittora/*
bittora ALL=(root) NOPASSWD: /usr/bin/mount -t cifs * /mnt/bittora/*
bittora ALL=(root) NOPASSWD: /usr/bin/mount -t nfs * /mnt/bittora/*
bittora ALL=(root) NOPASSWD: /usr/bin/umount /mnt/bittora/*
SUDOERS
chmod 440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" > /dev/null 2>&1 || { rm "$SUDOERS_FILE"; err "Invalid sudoers syntax!"; }

# ── 11. Systemd service ────────────────────────────────────────────
log "Installing systemd service..."
cp "$BITTORA_DIR/bittora.service" "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable bittora
systemctl start bittora

# ── 12. Done ────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  Bittora installed successfully!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "  Web UI:    ${CYAN}http://$(hostname -I | awk '{print $1}'):8080${NC}"
echo -e "  Username:  ${YELLOW}admin${NC}"
echo -e "  Password:  ${YELLOW}admin${NC}"
echo -e "  (You will be asked to change the password on first login)"
echo ""
echo -e "  Config:    $CONFIG_FILE"
echo -e "  Logs:      /var/log/bittora/"
echo -e "  Service:   systemctl status bittora"
echo ""

systemctl status bittora --no-pager -l || true
