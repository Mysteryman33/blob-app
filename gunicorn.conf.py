# Gunicorn config — auto-loaded by `gunicorn main:app` (Render's start command
# picks this up automatically; the --bind flag on the command still wins).
#
# Tuned for a small 512 MB instance. The default single sync worker can only
# handle one request at a time, so any parallel page load (the browser fetches
# the HTML + icons + static assets at once) or a brief worker restart makes
# Render's router return "no-server" 404s. A couple of threaded workers fixes
# that: redundancy (a restarting worker doesn't drop traffic) + concurrency for
# I/O-bound work (Postgres round-trips, Groq AI calls). App footprint is ~90 MB
# per worker, so 2 workers stays comfortably under the limit.
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"
workers = 2
threads = 4
worker_class = "gthread"
timeout = 60            # don't kill a worker mid AI/DB call (default 30s is too tight)
graceful_timeout = 30
keepalive = 5
preload_app = True      # load the app once in the master, then fork → lower memory
