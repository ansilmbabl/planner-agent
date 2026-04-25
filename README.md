# Planner Council

A local web app: you describe a product idea in chat, a **council of AI agents** (different “ideologies”, configured in [config/council.json](config/council.json)) runs **web research**, discusses in two rounds, may **ask you clarifying questions**, then writes a structured **`plan.md`** suitable for an agentic coding agent to implement.

- **Default LLM:** [Ollama](https://ollama.com/) (no API key). Optional: OpenAI or Anthropic via `LLM_PROVIDER` in `.env`.
- **Stack:** Python 3.10+ (FastAPI, SSE) + Vite React + Tailwind.

## Prerequisites

- Python 3.10+ (3.11 recommended)
- [Ollama](https://ollama.com/) for local models (e.g. `ollama pull llama3.2`)
- Node 20+ for the frontend

## Run (development)

**Terminal 1 — API** (from repo root you can set `PYTHONPATH=backend` or `cd` into `backend`):

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env
# edit .env if needed
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — UI**

```bash
cd frontend
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The Vite dev server proxies `/api` to the backend on port 8000.

## Single-port production (optional)

Build the client and point FastAPI at the `dist` folder:

```bash
cd frontend && npm run build
cd ../backend
# In .env:
# FRONTEND_DIST=/full/path/to/planner-agents/frontend/dist
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## `plan.md` format

The writer fills a Pydantic model and renders [backend/app/templates/plan.md.j2](backend/app/templates/plan.md.j2): problem & success, non-goals, constraints, stack table, data/interfaces, phases, file map, flows, testing, operations, open questions, and an implementation checklist.

## API

- `GET /api/health`
- `GET /api/models` — Ollama model tags when `LLM_PROVIDER=ollama`
- `POST /api/sessions` — `{ "model": "llama3.2" }` → session id
- `GET /api/sessions/{id}` — session + messages
- `POST /api/sessions/{id}/message` — `{ "content", "model"? }` — **SSE** stream (`data: {json}\n\n`)

## License

Use and modify as you like for your projects.
