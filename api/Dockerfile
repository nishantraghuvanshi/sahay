# Care API. Build from the REPO ROOT, not from api/:
#
#     docker build -f api/Dockerfile -t voxikin-api .
#
# Two things need the root. The app is imported as `api.main:app`, so `api/` has
# to be a package inside the working directory rather than the working directory
# itself; and api/config.py reads `env_file=".env"` relative to the process CWD.
FROM python:3.13-slim

# Bytecode written at import time is thrown away with the container, and an
# unflushed log line is a log line you do not have when the thing crashes.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY api/requirements.txt ./api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt

COPY api ./api
COPY scripts/mock-api.json ./scripts/mock-api.json

# Documentation only — the platform picks the real port and passes it as $PORT.
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8000')+'/health').status==200 else 1)"

# Shell form on purpose: $PORT has to be expanded at runtime, and exec form
# would pass the literal string.
CMD uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}
