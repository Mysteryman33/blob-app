# blob — your AI productivity companion

> A personal productivity app wrapped around an AI blob that lives on your screen, reacts to everything you do, and grows closer to you over time.

---

## what it is

blob is a Flask web app that combines a full productivity suite — tasks, habits, goals, focus timer, journal — with an animated companion that responds to your activity using Groq's LLaMA model. The blob has moods, familiarity tiers, a coin economy, and a customizable wardrobe. It remembers you.

---

## stack

| Layer | Tech |
|---|---|
| Backend | Python · Flask · SQLite |
| AI | Groq API — `llama-3.1-8b-instant` |
| Frontend | Vanilla JS · CSS · Jinja2 |
| No frameworks | no React, no Tailwind, no build step |

---

## setup

```bash
pip install -r requirements.txt
python main.py
```

Open `http://localhost:5000`. The database (`tasks.db`) is created automatically on first run.

**API key** — set `GROQ_API_KEY` as an environment variable, or edit `GROQ_KEY` in `main.py`.

---

## features

### tasks
Add, complete, delete, and categorize daily to-dos. Completing a task feeds the blob, adds to your streak, and earns coins. Uncompleting reverses everything.

### habits
Daily check-in tracking with three difficulty tiers (easy / medium / hard). Each tier earns different base coins. Streaks build a multiplier at day 7 (day 3 with the Party Hat equipped). Freeze tokens let you protect a streak when life happens. Pause any habit temporarily without losing it.

### goals
Outcome-based goals (not habits — things like "get a 6-pack" or "save $2k"). Each goal has a category, optional deadline, and a milestone list. Milestone completions auto-drive the progress bar. Habits can be linked to goals to show supporting evidence.

### focus (pomodoro)
25-minute work cycles with 5-minute short breaks and a 15-minute long break after every 4 sessions. Pause, resume, skip, or stop at any time. Sessions are logged and can be linked to tasks. The blob has timer-aware reactions.

### journal
Freeform daily entries. Recent entries surface in the Memories screen and feed into the AI Navigation analysis.

### navigation
An AI-powered self-discovery screen. On first open (or when you hit re-analyze), Groq reads your entire activity history and generates:
- **Life area radar** — scores for mental / emotional / physical / social / spiritual / financial health, inferred from your task categories, habit types, and journal tone
- **Identity snapshot** — core values, personality type, energy pattern, self-awareness and consistency scores
- **Career paths** — 3–5 options with alignment %, earning/fulfillment/growth ratings, one marked primary
- **Passions** — inferred from focus session labels, task categories, and habit choices

### shop
18 items across 4 tiers. Spend coins earned from tasks and habits. Items have real gameplay effects that stack.

| Tier | Items |
|---|---|
| Common | Bow · Sunglasses · Cat Ears · Flower |
| Rare | Lucky Charm · Party Hat · Monocle · Top Hat · Scarf |
| Epic | Headphones · Frost Badge · Wizard Hat · Devil Horns · Angel Wings |
| Legendary | Hero Cape · Crown · Halo · Dragon Wings |

**Effect examples** — Crown multiplies all coins ×1.5. Scarf makes feeding cost 20 coins instead of 30. Dragon Wings add +10 coins to every action. Sunglasses, Angel Wings, and Halo stack familiarity bonuses per chat. Items are previewed live on the blob before buying.

### achievements
14 unlockable badges — first task, streaks, coin milestones, habit check-ins, journal entries, goal completion, reaching level 5, best-friends familiarity, and more.

### memories
A snapshot of your last 5 journal entries and 8 most recently completed tasks.

---

## the blob

The blob is the core of the app. It floats freely around the screen, reacts to every action, and evolves with you.

### familiarity tiers
The blob's personality is determined by your `familiarity` stat (0–100):

| Familiarity | Tier | Personality |
|---|---|---|
| 0–19 | terrified | stutters · barely speaks · scared |
| 20–41 | shy | soft · unsure · slowly warming up |
| 42–64 | cautious | neutral · starting to trust |
| 65–84 | friendly | warm · caring · enthusiastic |
| 85–100 | bonded | loves you · ALLCAPS energy |

### coin economy
Tasks, habits, and chat all earn coins. Equipped items modify every reward. Coins are spent in the shop and on feeding.

```
task coins → lucky_charm ×1.5 → monocle +3 → top_hat +2 → devil_horns +5 
           → dragon_wings +10 → hero_cape ×1.25 → crown ×1.5
```

### weather
The blob's mood changes the background weather:

| Mood | Weather |
|---|---|
| happy | sunny rays |
| excited | sparkle + rays |
| sad / punched | heavy rain |
| dizzy | storm + lightning |
| curious | drifting clouds |
| scared | fog |
| normal | clear |

### hero mode
On the My Blob screen, the blob floats to the center stage and scales up to 1.75×. Drag it away — it drifts back on its own after 2.5 seconds. In the shop, the blob locks into a dedicated preview stage at the top so you can see accessories live. On memories, achievements, and settings, the blob hides entirely.

### ai chat
The blob talks. Every message runs two Groq calls in parallel:
1. **Main chat** — tool calling with the full task/habit/goal context. The blob can create tasks, start timers, check habits, add goals, and more — all from natural language.
2. **Sentiment analysis** — scores your message's emotional tone and adjusts the blob's happiness, energy, and familiarity in real time.

**Tool types:**
- **Immediate** — execute instantly (start/pause/stop focus, check habit)
- **Proposed** — shown for confirmation before executing (add/delete/complete tasks, add/edit goals and habits)

---

## file structure

```
main.py              — Flask routes, DB schema, Groq tool execution, shop logic
static/
  pet.js             — all frontend logic (~3500 lines): blob physics, chat, screens, shop, weather
  style.css          — all styles
templates/
  index.html         — single-page app shell, blob SVGs (floating + preview)
tasks.db             — SQLite database (auto-created)
```

---

## database

14 tables: `tasks` · `pet` · `shop_owned` · `habits` · `goals` · `goal_milestones` · `goal_habit_links` · `journal` · `notes` · `focus_sessions` · `budget` · `nav_life_areas` · `nav_identity` · `nav_career_paths` · `nav_passions`

---

## status

PC / web version — **complete** as of May 2026.
