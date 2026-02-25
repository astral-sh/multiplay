FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

# Install Node.js for pyright
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Install type checkers as global tools
RUN uv tool install ty && \
    uv tool install pyright && \
    uv tool install pyrefly && \
    uv tool install mypy && \
    uv tool install zuban && \
    uv tool install pycroscope
ENV PATH="/root/.local/bin:$PATH" \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (cached layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project --no-dev

# Copy application and install the project itself
COPY . .
RUN uv sync --locked --no-dev

EXPOSE 8000

CMD ["uv", "run", "multiplay", "--host", "0.0.0.0", "--skip-prime"]
