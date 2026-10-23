#!/bin/zsh
# Monday launcher: starts the server if it isn't running, then opens the app
# as a standalone Chrome window (falls back to the default browser).
APP_DIR="${0:A:h:h}"
URL="http://localhost:3941"
NODE="/opt/homebrew/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"
LOG="$HOME/Library/Logs/tmua-tutor.log"
# Finder/launchd hand us a bare PATH; poppler (pdftoppm/pdfinfo) lives in Homebrew.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! /usr/bin/curl -s -m 1 -o /dev/null "$URL/api/tree"; then
  cd "$APP_DIR" || exit 1
  /usr/bin/nohup "$NODE" server/index.js >> "$LOG" 2>&1 &
  for i in {1..60}; do
    /usr/bin/curl -s -m 1 -o /dev/null "$URL/api/tree" && break
    /bin/sleep 0.25
  done
fi

if [[ -d "/Applications/Google Chrome.app" ]]; then
  open -na "Google Chrome" --args --app="$URL"
else
  open "$URL"
fi
