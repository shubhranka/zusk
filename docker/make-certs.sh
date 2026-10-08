# Runs in the one-shot `certs` service before Postgres starts. Creates a
# self-signed certificate for localhost in the shared `certs` volume, so the
# SSL modes can be tested without a key checked into the repository.
set -e

if [ -f /certs/server.key ]; then
  exit 0
fi

apk add --no-cache openssl >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout /certs/server.key -out /certs/server.crt 2>/dev/null
# 00-ssl.sh runs as the postgres user and copies these into PGDATA with 0600.
chmod 644 /certs/server.key /certs/server.crt
echo "Created a self-signed localhost certificate."
