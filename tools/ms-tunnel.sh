#!/bin/bash
# usage: bash setup.sh <ttyd_password>
PW="$1"; [ -z "$PW" ] && { echo "need password"; exit 1; }
mkdir -p ~/tun && cd ~/tun
dl() { # $1 out  $2 github url
  [ -s "$1" ] && return 0
  for p in "" "https://ghfast.top/" "https://gh-proxy.com/"; do
    curl -fsSL --max-time 120 -o "$1" "${p}$2" && [ -s "$1" ] && chmod +x "$1" && return 0
  done
  echo "DOWNLOAD FAILED: $1"; return 1
}
dl ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64
dl cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
pkill -f 'ttyd -p 7681'; pkill -f 'cloudflared tunnel'; pkill -f keepalive.sh
nohup ./ttyd -p 7681 -W -c "admin:$PW" bash > ttyd.log 2>&1 &
nohup ./cloudflared tunnel --no-autoupdate --url http://127.0.0.1:7681 > cf.log 2>&1 &
# keepalive: authenticated Jupyter API call every 10 min (updates last_activity)
cat > keepalive.sh <<'K'
#!/bin/bash
while true; do
  for u in $(jupyter server list 2>/dev/null | grep -o 'http[^ ]*token=[^ ]*'; jupyter notebook list 2>/dev/null | grep -o 'http[^ ]*token=[^ ]*'); do
    base="${u%%\?*}"; tok="${u##*token=}"
    curl -s -o /dev/null -H "Authorization: token $tok" "${base%/}/api/contents" && echo "$(date '+%F %T') ping ok $base"
  done
  echo "$(date '+%F %T') alive"
  sleep 600
done
K
chmod +x keepalive.sh
nohup ./keepalive.sh > keepalive.log 2>&1 &
sleep 15
echo "USER: $(whoami)  OS: $(. /etc/os-release; echo $PRETTY_NAME)"
echo "TUNNEL: $(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' cf.log | head -1)"
tail -2 keepalive.log
