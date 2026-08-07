#!/usr/bin/env bash
#
# Restart the plugin by killing its process; Stream Deck respawns it within a
# few seconds. Used as the rebuild hook for `npm run watch`.
#
# Why not `streamdeck restart`? On Stream Deck 7.4.2 it prints "Restarted" and
# exits 0 while the plugin keeps running the old bundle — the PID never
# changes. Killing the process is the only thing observed to actually reload.
#
# Why the `comm` check? `pkill -f` matches any process whose *full command
# line* contains the pattern, which includes unrelated shells, editors, and
# greps that merely mention the plugin path. A rebuild firing mid-command
# would kill them. Matching on the executable name as well as the path means
# only the real Node process is ever signalled.

set -uo pipefail

# Deliberately NOT anchored on the "Plugins/" symlink directory. Stream Deck
# launches the plugin by whichever path it resolved at load time: the symlink
# path after `streamdeck link`, but the real project path after the app is
# fully restarted. Requiring "Plugins/" matched nothing in the second case, so
# this script reported success and reloaded nothing — the same silent no-op it
# exists to replace.
PATTERN='com\.alejo\.claude-usage\.sdPlugin/bin/plugin\.js'

killed=0
for pid in $(pgrep -f "$PATTERN" 2>/dev/null); do
  # Skip ourselves and our own process group.
  [ "$pid" = "$$" ] && continue
  # Only ever kill Node — never a shell that happens to name the path.
  case "$(ps -p "$pid" -o comm= 2>/dev/null)" in
    *node*) ;;
    *) continue ;;
  esac
  # And only the process Stream Deck itself spawned: it is the only one handed
  # a -pluginUUID. Without this the broadened pattern above could match a Node
  # process that merely mentions the bundle path in its arguments.
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in
    *-pluginUUID*) kill "$pid" 2>/dev/null && killed=$((killed + 1)) ;;
  esac
done

if [ "$killed" -gt 0 ]; then
  echo "reload: stopped $killed plugin process(es); Stream Deck will respawn"
else
  echo "reload: plugin was not running (Stream Deck will start it on demand)"
fi

# Never fail the watch pipeline — a missing process is not an error.
exit 0
