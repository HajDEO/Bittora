#!/bin/bash
set -e

# Bittora Installer
# Supports: Ubuntu 22.04+, Debian 12+
# Usage: sudo bash install.sh [-v|--verbose]

BITTORA_DIR="/opt/bittora"
BITTORA_USER="bittora"
BITTORA_GROUP="bittora"
CONFIG_FILE="$BITTORA_DIR/config.json"
SERVICE_FILE="/etc/systemd/system/bittora.service"
SUDOERS_FILE="/etc/sudoers.d/bittora"
MOUNT_BASE="/mnt/bittora"
NODE_MAJOR=22
VERBOSE=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# Verbose helpers — redirect output based on verbose flag
quiet() {
    if [ "$VERBOSE" -eq 1 ]; then
        "$@"
    else
        "$@" > /dev/null 2>&1
    fi
}

apt_install() {
    if [ "$VERBOSE" -eq 1 ]; then
        apt-get install -y "$@"
    else
        apt-get install -y -qq "$@" > /dev/null 2>&1
    fi
}

pip_install() {
    if [ "$VERBOSE" -eq 1 ]; then
        PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --root-user-action=ignore --ignore-installed -r "$1"
    else
        PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install -q --root-user-action=ignore --ignore-installed -r "$1"
    fi
}

# ══════════════════════════════════════════════════════════════════
# PARSE ARGUMENTS
# ══════════════════════════════════════════════════════════════════

for arg in "$@"; do
    case "$arg" in
        -v|--verbose)
            VERBOSE=1
            ;;
    esac
done

# ══════════════════════════════════════════════════════════════════
# PRE-FLIGHT CHECKS
# ══════════════════════════════════════════════════════════════════

if [ "$EUID" -ne 0 ]; then
    err "Please run as root: sudo bash install.sh"
fi

# Detect distro
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO_ID="$ID"
    DISTRO_VER="$VERSION_ID"
else
    DISTRO_ID="unknown"
    DISTRO_VER=""
fi

case "$DISTRO_ID" in
    ubuntu|debian)
        info "Detected: $PRETTY_NAME"
        ;;
    *)
        warn "Unsupported distro: $DISTRO_ID — this installer is designed for Ubuntu/Debian"
        warn "Continuing anyway, but some packages may not be available"
        ;;
esac

if [ "$VERBOSE" -eq 1 ]; then
    info "Verbose mode enabled"
fi

# ══════════════════════════════════════════════════════════════════
# SHARED FUNCTIONS
# ══════════════════════════════════════════════════════════════════

ensure_user() {
    if ! id "$BITTORA_USER" &>/dev/null; then
        log "Creating system user '$BITTORA_USER'..."
        useradd -r -s /usr/sbin/nologin -d /opt/bittora "$BITTORA_USER"
    else
        [ "$VERBOSE" -eq 1 ] && info "User '$BITTORA_USER' already exists"
    fi
}

install_system_deps() {
    log "Installing system dependencies..."
    if [ "$VERBOSE" -eq 1 ]; then
        apt-get update
    else
        apt-get update -qq
    fi

    # Base packages needed before anything else (minimal Debian may lack these)
    apt_install ca-certificates curl gnupg sudo

    # Core application dependencies
    local PKGS="python3 python3-pip python3-venv git wget smbclient nfs-common cifs-utils"

    # python3-libtorrent: available on Ubuntu 22.04+ and Debian 12+
    if apt-cache show python3-libtorrent &>/dev/null; then
        PKGS="$PKGS python3-libtorrent"
    else
        warn "python3-libtorrent not found in repos — will try pip fallback"
    fi

    apt_install $PKGS

    # Fallback: if libtorrent not available via apt, try pip
    if ! python3 -c "import libtorrent" &>/dev/null; then
        warn "Installing libtorrent via pip (no system package found)..."
        PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --root-user-action=ignore libtorrent || \
            err "Could not install libtorrent. Please install python3-libtorrent manually."
    fi
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
    quiet bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
    apt_install nodejs

    # Verify installation
    if ! command -v node &>/dev/null; then
        err "Node.js installation failed. Check your internet connection and try again."
    fi
    info "Node.js installed: $(node -v)"
}

install_python_deps() {
    log "Installing Python dependencies..."
    pip_install "$BITTORA_DIR/requirements.txt"
}

build_frontend() {
    log "Building frontend..."
    cd "$BITTORA_DIR/frontend"
    if [ "$VERBOSE" -eq 1 ]; then
        npm install
        npm run build
    else
        npm install --silent
        npm run build
    fi
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

fix_lxc_permissions() {
    local in_lxc=0

    # Detect LXC: systemd-detect-virt
    if command -v systemd-detect-virt &>/dev/null; then
        local virt_type
        virt_type=$(systemd-detect-virt --container 2>/dev/null || true)
        [ "$virt_type" = "lxc" ] || [ "$virt_type" = "lxc-libvirt" ] && in_lxc=1
    fi
    # Detect LXC: /proc/1/environ
    if [ "$in_lxc" -eq 0 ] && [ -r /proc/1/environ ]; then
        tr '\0' '\n' < /proc/1/environ 2>/dev/null | grep -q '^container=lxc' && in_lxc=1
    fi
    # Detect LXC: filesystem markers
    if [ "$in_lxc" -eq 0 ]; then
        [ -d /run/lxc ] || [ -d /.lxcfs ] || [ -f /dev/lxc ] && in_lxc=1
    fi

    if [ "$in_lxc" -eq 0 ]; then
        [ "$VERBOSE" -eq 1 ] && info "Not in LXC — skipping mount permission fix"
        return 0
    fi

    log "LXC container detected — checking mount permissions..."

    [ ! -d "$MOUNT_BASE" ] && return 0

    local has_mounts=0
    for dir in "$MOUNT_BASE"/*/; do [ -d "$dir" ] && has_mounts=1 && break; done
    [ "$has_mounts" -eq 0 ] && return 0

    local bittora_groups fixed=0
    bittora_groups=$(id -G "$BITTORA_USER" 2>/dev/null || echo "")
    [ -z "$bittora_groups" ] && return 0

    for dir in "$MOUNT_BASE"/*/; do
        [ -d "$dir" ] || continue
        local mount_gid
        mount_gid=$(stat -c %g "$dir" 2>/dev/null || echo "")
        [ -z "$mount_gid" ] && continue
        [ "$mount_gid" -eq 0 ] 2>/dev/null && continue

        local already=0
        for gid in $bittora_groups; do [ "$gid" = "$mount_gid" ] && already=1 && break; done
        [ "$already" -eq 1 ] && continue

        local group_name
        group_name=$(getent group "$mount_gid" 2>/dev/null | cut -d: -f1 || echo "")
        if [ -z "$group_name" ]; then
            group_name="lxc_mount_${mount_gid}"
            log "Creating group '$group_name' (GID $mount_gid)..."
            groupadd -g "$mount_gid" "$group_name"
        fi

        log "Adding $BITTORA_USER to group '$group_name' (GID $mount_gid) for $(basename "$dir")..."
        usermod -aG "$group_name" "$BITTORA_USER"
        fixed=$((fixed + 1))
        bittora_groups=$(id -G "$BITTORA_USER" 2>/dev/null || echo "$bittora_groups")
    done

    [ "$fixed" -gt 0 ] && log "Fixed $fixed mount permission(s) for LXC"
}

ensure_config() {
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
        [ "$VERBOSE" -eq 1 ] && info "config.json already exists — not overwriting"
    fi
}

print_info() {
    local PORT=8080
    if [ -f "$CONFIG_FILE" ]; then
        PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('port', 8080))" 2>/dev/null || echo 8080)
    fi
    local IP=$(hostname -I | awk '{print $1}')
    echo ""
    echo -e "  Web UI:    ${CYAN}http://${IP}:${PORT}${NC}"
    echo -e "  Username:  ${YELLOW}admin${NC}"
    echo -e "  Password:  ${YELLOW}admin${NC}"
    echo -e "  (Change password on first login)"
    echo ""
    echo -e "  Config:    $CONFIG_FILE"
    echo -e "  Logs:      /var/log/bittora/"
    echo -e "  Service:   systemctl status bittora"
    echo ""
}

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
    git config --global --add safe.directory "$BITTORA_DIR" 2>/dev/null || true
    git fetch origin
    git reset --hard origin/main

    install_system_deps
    install_node
    ensure_user
    install_python_deps
    build_frontend
    ensure_directories
    fix_lxc_permissions
    ensure_config
    set_permissions
    install_sudoers
    install_service

    log "Restarting Bittora..."
    systemctl restart bittora

    echo ""
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Update complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════${NC}"
    print_info
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
ensure_user

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

# ── 7b. LXC mount permissions ─────────────────────────────────────
fix_lxc_permissions

# ── 8. Generate config ─────────────────────────────────────────────
ensure_config

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
print_info
systemctl status bittora --no-pager -l || true
