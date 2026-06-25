#!/bin/bash
# Double-click to launch the in-progress dev build with the latest code.
# It uses its own data folder ("Backbone (Dev)") so it never touches the
# installed app. Quit it by closing this Terminal window or pressing Ctrl-C.
cd "$(dirname "$0")"
echo "Launching Backbone (Dev) with the current code…"
echo "(leave this window open while you use it)"
npm start
