# Stage 1: Build the React frontend
# Build context is the repo root (fly.toml uses dockerfile = "backend/Dockerfile").
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

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

# Copy the built React SPA into the image. FastAPI's StaticFiles mount
# serves these from /app/static/ in production.
COPY --from=frontend-builder /frontend/dist/ ./static/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
