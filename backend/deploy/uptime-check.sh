#!/usr/bin/env bash
# Checks the API readiness endpoint every 5 minutes and alerts via the configured Telegram
# bot or generic webhook (values read from ~/noma/backend/.env).
# Installed on the build server as /home/ubuntu/noma/uptime-check.sh via crontab (*/5 * * * *).
set -u
ENV_FILE=${NOMA_ENV_FILE:-/home/ubuntu/noma/backend/.env}
get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

CODE=$(curl -s -o /tmp/noma-ready.json -w '%{http_code}' --max-time 10 http://127.0.0.1:3100/ready || echo 000)
if [ "$CODE" = "200" ]; then exit 0; fi

BODY=$(head -c 300 /tmp/noma-ready.json 2>/dev/null || echo '')
MSG="NOMA /ready is down (http $CODE): $BODY"
echo "$(date -Is) $MSG" >> /home/ubuntu/noma-uptime.log

TOKEN=$(get TELEGRAM_BOT_TOKEN); CHAT=$(get TELEGRAM_CHAT_ID); HOOK=$(get ALERT_WEBHOOK_URL)
if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
  curl -s --max-time 10 -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -d "chat_id=$CHAT" --data-urlencode "text=$MSG" >/dev/null || true
fi
if [ -n "$HOOK" ]; then
  curl -s --max-time 10 -X POST "$HOOK" -H 'content-type: application/json' \
    -d "{\"kind\":\"alert\",\"message\":\"NOMA /ready down\",\"details\":{\"status\":\"$CODE\"},\"text\":\"$MSG\"}" >/dev/null || true
fi
exit 1
