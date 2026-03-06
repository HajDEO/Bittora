# Bittora

A lightweight, self-hosted torrent manager with a modern web UI. Built with FastAPI, libtorrent, and React.

## Features

- **Web UI** — Clean, responsive dark interface with real-time updates via WebSocket
- **User management** — Multi-user with admin/user roles and granular permissions
- **Categories** — Organize torrents with color-coded categories
- **RSS feeds** — Auto-download torrents from RSS feeds with pattern matching
- **Scheduler** — Interactive 24x7 speed schedule grid
- **Storage options** — Local, NFS/SMB mount, or FTP upload on completion
- **Mount helper** — Mount/unmount SMB and NFS shares directly from the UI
- **IP filtering** — Block peers by IP range
- ***arr integration** — qBittorrent API v2 compatible, works with Sonarr, Radarr, Lidarr, etc.
- **Webhooks** — Notify external services on torrent completion
- **Resume data** — Torrents persist across restarts
- **Resource limits** — Built-in memory and CPU limits via systemd

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python 3, FastAPI, libtorrent |
| Frontend | React 18, Vite |
| Database | SQLite (SQLAlchemy) |
| Auth | JWT via HttpOnly cookies |
| Service | systemd |

## Quick Install

On a fresh Ubuntu/Debian server:

```bash
git clone https://github.com/HajDEO/Bittora.git /opt/bittora
cd /opt/bittora
sudo bash install.sh
```

The installer handles everything: dependencies, Node.js, system user, directories, frontend build, systemd service, and sudoers rules for mount operations.

## Update

```bash
cd /opt/bittora
sudo bash install.sh
```

The installer detects an existing installation and runs in update mode: pulls latest code, rebuilds frontend, and restarts the service. Your `config.json` is never overwritten.

## Manual Install

<details>
<summary>Step-by-step instructions</summary>

```bash
# 1. System deps
sudo apt update
sudo apt install python3 python3-pip python3-libtorrent git curl smbclient nfs-common cifs-utils

# 2. Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install nodejs

# 3. Clone
sudo git clone https://github.com/HajDEO/Bittora.git /opt/bittora

# 4. Python deps
sudo pip3 install -r /opt/bittora/requirements.txt

# 5. Frontend
cd /opt/bittora/frontend
sudo npm install
sudo npm run build

# 6. System user + dirs
sudo useradd -r -s /usr/sbin/nologin -d /opt/bittora bittora
sudo mkdir -p /srv/bittora/downloads /var/lib/bittora /var/log/bittora /mnt/bittora

# 7. Config
sudo cp /opt/bittora/config.example.json /opt/bittora/config.json
# Edit config.json and set a random secret:
# python3 -c "import secrets; print(secrets.token_hex(32))"

# 8. Permissions
sudo chown -R bittora:bittora /opt/bittora /srv/bittora /var/lib/bittora /var/log/bittora
sudo chmod +x /opt/bittora/start.sh

# 9. Systemd
sudo cp /opt/bittora/bittora.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bittora
```

</details>

## Configuration

`config.json` in the project root:

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `8080` | Web UI and API port |
| `lang` | `en` | Language (`en`, `sk`) |
| `download_dir` | `/srv/bittora/downloads` | Default download directory |
| `data_dir` | `/var/lib/bittora` | Database and resume data |
| `log_dir` | `/var/log/bittora` | Log files |
| `secret` | *(generated)* | JWT signing secret (keep private!) |

## *arr Integration

Bittora exposes a qBittorrent-compatible API v2, so Sonarr, Radarr, Lidarr, and other *arr apps can use it as a download client.

**Setup in Sonarr/Radarr:**

1. Go to **Settings > Download Clients > Add > qBittorrent**
2. Set:
   - **Host:** your server IP
   - **Port:** `8080` (or your configured port)
   - **Username:** your Bittora username
   - **Password:** your Bittora password
3. Click **Test** then **Save**

The following qBittorrent API v2 endpoints are implemented:

- `POST /api/v2/auth/login` — authenticate (returns SID cookie)
- `GET /api/v2/app/version` — app version
- `GET /api/v2/app/webapiVersion` — API version
- `GET /api/v2/app/preferences` — app preferences
- `GET /api/v2/torrents/info` — list torrents
- `GET /api/v2/torrents/properties` — torrent details
- `POST /api/v2/torrents/add` — add torrent (magnet or .torrent file)
- `POST /api/v2/torrents/pause` — pause torrents
- `POST /api/v2/torrents/resume` — resume torrents
- `POST /api/v2/torrents/delete` — delete torrents
- `GET /api/v2/torrents/categories` — list categories
- `GET /api/v2/transfer/info` — transfer stats

## Default Credentials

| Username | Password |
|----------|----------|
| `admin` | `admin` |

You will be prompted to change the password on first login.

## Service Management

```bash
sudo systemctl status bittora    # Check status
sudo systemctl restart bittora   # Restart
sudo systemctl stop bittora      # Stop
journalctl -u bittora -f         # Follow logs
```

## Support

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1E61VGHII)

## License

[MIT](LICENSE)
