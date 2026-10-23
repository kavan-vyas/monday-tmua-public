#!/bin/zsh
cd "$(dirname "$0")"
if ! curl -s -o /dev/null localhost:3941/api/tree; then
  nohup node server/index.js > /tmp/tmua-server.log 2>&1 &
  sleep 1.5
fi
open http://localhost:3941
