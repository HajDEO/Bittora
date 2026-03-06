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
NODE_MAJOR=22

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# ══════════════════════════════════════════════════════════════════
# SHARED FUNCTIONS
# ══════════════════════════════════════════════════════════════════

install_system_deps() {
    log "Installing system dependencies..."
    apt-get update -qq
    apt-get install -y -qq \
        python3 python3-pip python3-venv python3-libtorrent \
        git curl wget smbclient nfs-common cifs-utils \
        > /dev/null 2>&1
}

install_node() {
    if command -v node &> /dev/null; then
        NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
            info "Node.js already installed: $(node -v)"
            return
        fi
        warn "Node.js $(node -v) is too old (need 18+), upgrading..."
    fi
    log "Installing Node.js ${NODE_MAJOR}.x..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
}

install_python_deps() {
    log "Installing Python dependencies..."
    PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install -q --ignore-installed -r "$BITTORA_DIR/requirements.txt"
}

build_frontend() {
    log "Building frontend..."
    cd "$BITTORA_DIR/frontend"
    npm install --silent
    npm run build
}

ensure_directories() {
    log "Ensuring directories exist..."
    mkdir -p /srv/bittora/downloads
    mkdir -p /var/lib/bittora
    mkdir -p /var/log/bittora
    mkdir -p "$MOUNT_BASE"
}

set_permissions() {
    log "Setting permissions..."
    chown -R "$BITTORA_USER:$BITTORA_GROUP" "$BITTORA_DIR"
    chown -R "$BITTORA_USER:$BITTORA_GROUP" /srv/bittora
    chown -R "$BITTORA_USER:$BITTORA_GROUP" /var/lib/bittora
    chown -R "$BITTORA_USER:$BITTORA_GROUP" /var/log/bittora
    chown "$BITTORA_USER:$BITTORA_GROUP" "$MOUNT_BASE"
    chmod +x "$BITTORA_DIR/start.sh"
}

install_sudoers() {
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
}

install_service() {
    log "Installing systemd service..."
    cp "$BITTORA_DIR/bittora.service" "$SERVICE_FILE"
    systemctl daemon-reload
}

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

    install_system_deps
    install_node
    install_python_deps
    build_frontend
    ensure_directories
    set_permissions
    install_sudoers
    install_service

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
install_system_deps

# ── 2. Node.js ──────────────────────────────────────────────────────
install_node

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
install_python_deps

# ── 6. Frontend build ──────────────────────────────────────────────
build_frontend

# ── 7. Directories ─────────────────────────────────────────────────
ensure_directories

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
set_permissions

# ── 10. Sudoers for mount/umount ────────────────────────────────────
install_sudoers

# ── 11. Systemd service ────────────────────────────────────────────
install_service
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
