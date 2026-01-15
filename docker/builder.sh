#!/bin/sh
# AstroAdmin Builder Script
# Polls for changes in the remote repo and rebuilds when detected

POLL_INTERVAL=${POLL_INTERVAL:-60}
BRANCH=${BRANCH:-main}

cd /site-live

echo "[$(date)] Builder started"
echo "[$(date)] Polling every ${POLL_INTERVAL}s for changes on ${BRANCH}"

# Initial build on startup if dist is empty
if [ ! -f "/dist/index.html" ]; then
    echo "[$(date)] Initial build..."

    echo "[$(date)] Installing dependencies..."
    if ! npm install; then
        echo "[$(date)] Error: npm install failed, will retry on next poll"
    else
        echo "[$(date)] Building site..."
        if ! npm run build; then
            echo "[$(date)] Error: build failed, will retry on next poll"
        else
            rm -rf /dist/* 2>/dev/null || true
            cp -r dist/* /dist/
            echo "[$(date)] Initial build complete"
        fi
    fi
fi

while true; do
    # Fetch latest from remote
    git fetch origin "$BRANCH" --quiet 2>/dev/null || {
        echo "[$(date)] Warning: git fetch failed, retrying in ${POLL_INTERVAL}s"
        sleep "$POLL_INTERVAL"
        continue
    }

    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")

    if [ "$LOCAL" != "$REMOTE" ]; then
        echo "[$(date)] Changes detected (${LOCAL:0:7} -> ${REMOTE:0:7})"
        echo "[$(date)] Pulling changes..."

        git pull origin "$BRANCH" --ff-only || {
            echo "[$(date)] Error: git pull failed"
            sleep "$POLL_INTERVAL"
            continue
        }

        echo "[$(date)] Installing dependencies..."
        npm install || {
            echo "[$(date)] Error: npm install failed"
            sleep "$POLL_INTERVAL"
            continue
        }

        echo "[$(date)] Building site..."
        npm run build || {
            echo "[$(date)] Error: build failed"
            sleep "$POLL_INTERVAL"
            continue
        }

        # Atomic-ish swap to dist volume
        echo "[$(date)] Deploying to dist..."
        rm -rf /dist/* 2>/dev/null || true
        cp -r dist/* /dist/

        echo "[$(date)] Deploy complete"
    fi

    sleep "$POLL_INTERVAL"
done
