# Runs once, as the postgres user, before the SQL seed files.
# Copies the self-signed dev certificate (made by docker/make-certs.sh,
# localhost only — never use it anywhere else) into PGDATA with the permissions Postgres requires,
# and turns SSL on for the real server start that follows initialisation.
install -m 600 /certs/server.crt "$PGDATA/server.crt"
install -m 600 /certs/server.key "$PGDATA/server.key"
cat >> "$PGDATA/postgresql.conf" <<CONF

# Added by docker/seed/00-ssl.sh
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
CONF
