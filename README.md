# Planner Council

A local web app: you describe a product idea in chat, a **council of AI agents** (different “ideologies”, configured in [config/council.json](config/council.json)) runs **web research**, discusses in two rounds, may **ask you clarifying questions**, then writes a structured **`plan.md`** suitable for an agentic coding agent to implement.

- **Default LLM:** [Ollama](https://ollama.com/) (no API key). Optional: OpenAI or Anthropic via `LLM_PROVIDER` in `.env`.
- **Stack:** Python 3.10+ (FastAPI, SSE) + Vite React + Tailwind.

## Prerequisites

- Python 3.10+ (3.11 recommended)
- [Ollama](https://ollama.com/) for local models (e.g. `ollama pull llama3.2`)
- Node 20+ for the frontend (only if you develop without Docker)

## Run with Docker

Single image: builds the Vite app and serves it with FastAPI on port **8000**.

**Ollama on your machine** (typical): start Ollama on the host (`ollama serve`), pull a model (`ollama pull llama3.2`), then:

```bash
docker compose up --build
```

Open [http://localhost:8000](http://localhost:8000). The container uses `OLLAMA_BASE_URL=http://host.docker.internal:11434` to reach the host (works on Docker Desktop; Linux uses `host-gateway` in [docker-compose.yml](docker-compose.yml)).

**Ollama inside Docker** (optional profile, large image — first time pull a model into the volume):

```bash
OLLAMA_BASE_URL=http://ollama:11434 docker compose --profile ollama up --build
docker compose exec ollama ollama pull llama3.2
```

**Image only** (no compose):

```bash
docker build -t planner-council .
docker run --rm -p 8000:8000 -e OLLAMA_BASE_URL=http://host.docker.internal:11434 --add-host=host.docker.internal:host-gateway planner-council
```

Override `OLLAMA_MODEL`, `LLM_PROVIDER`, or API keys with `-e` / a `.env` file as in [.env.example](.env.example).

### Docker + Ollama troubleshooting

- **`404` on `.../api/chat` (from the app in Docker):**  
  1) On the machine where Ollama runs, pull the model the UI uses: `ollama pull llama3.2` (or change **Model** in the UI / set `OLLAMA_MODEL` to a name from `ollama list`).  
  2) Ensure the API can reach that host: `OLLAMA_BASE_URL` must point at a running Ollama (default in compose: `http://host.docker.internal:11434` for the host Ollama app).  
  3) Upgrade Ollama if it is very old; `/api/chat` must exist on your Ollama version.

- **UI shows Ollama connected but 0 models:** run `ollama pull …` on the Ollama host, then use **Refresh connection** in the app.

- **`GET /api/health`** now includes an `ollama` block with reachability and model count for debugging.

- **HTTP 400 from `/api/chat`:** Ollama returns a JSON `error` describing the issue. Common case: the selected model is **not a text chat model** (e.g. image/diffusion tags like `flux`, `z-image`). Use a model meant for chat: `qwen3-coder`, `llama3`, `gemma3`, `mistral`, etc. (see `ollama list` and the model’s docs on ollama.com).

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
