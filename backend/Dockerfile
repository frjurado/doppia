# Stage 1: Build the React frontend
# Build context is the repo root (fly.toml uses dockerfile = "backend/Dockerfile").
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./

# Supabase credentials are no longer baked into the SPA: the browser never calls
# Supabase Auth directly (ADR-035 — the /api/v1/auth router proxies the grant
# server-side). Only the public soundfont base URL remains a build-time var.
ARG VITE_SOUNDFONT_BASE_URL
ENV VITE_SOUNDFONT_BASE_URL=$VITE_SOUNDFONT_BASE_URL

RUN npm run build
# Output: /frontend/dist/


# Stage 2: Python backend + built frontend assets
FROM python:3.12-slim
WORKDIR /app

# System dependencies required by music21, lxml, and verovio
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxml2 \
    libxslt1.1 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY backend/ ./backend/
COPY scripts/ ./scripts/

# Copy the built React SPA into the image. FastAPI's StaticFiles mount
# serves these from /app/static/ in production.
COPY --from=frontend-builder /frontend/dist/ ./static/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
