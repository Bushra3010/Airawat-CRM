#!/bin/sh
# Creates a private certificate authority (once) and an HTTPS certificate for this
# computer's names and LAN address, so phones on the showroom Wi-Fi can use the camera.
# Usage: npm run cert            (re-run if the computer's LAN address changes)
#        EXTRA_HOSTS="showroom.lan 10.0.0.5" npm run cert
set -e
cd "$(dirname "$0")/.."
mkdir -p certs
chmod 700 certs
CA_KEY=certs/ca.key CA_CRT=certs/ca.crt

if [ ! -f "$CA_KEY" ]; then
  openssl genrsa -out "$CA_KEY" 2048 2>/dev/null
  chmod 600 "$CA_KEY"
  openssl req -x509 -new -key "$CA_KEY" -sha256 -days 3650 -out "$CA_CRT" \
    -subj "/O=Airawat Handicraft/CN=Airawat Showroom Local CA" \
    -extensions v3_ca -config /dev/stdin <<CONF
[req]
distinguished_name=dn
[dn]
[v3_ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CONF
  echo "Created certificate authority certs/ca.crt"
fi

HOST=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
IPS=""
for IF in en0 en1 en2; do IP=$(ipconfig getifaddr $IF 2>/dev/null || true); [ -n "$IP" ] && IPS="$IPS $IP"; done
SAN="DNS:localhost,DNS:$HOST.local,IP:127.0.0.1"
for IP in $IPS; do SAN="$SAN,IP:$IP"; done
for H in $EXTRA_HOSTS; do
  case "$H" in *[!0-9.]*) SAN="$SAN,DNS:$H";; *) SAN="$SAN,IP:$H";; esac
done

openssl genrsa -out certs/server.key 2048 2>/dev/null
chmod 600 certs/server.key
openssl req -new -key certs/server.key -subj "/O=Airawat Handicraft/CN=$HOST.local" -out certs/server.csr
cat > certs/server.ext <<CONF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
CONF
# 397 days: the longest validity Apple and Chrome accept for server certificates
openssl x509 -req -in certs/server.csr -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out certs/server.crt -days 397 -sha256 -extfile certs/server.ext 2>/dev/null
rm -f certs/server.csr certs/server.ext
echo "HTTPS certificate created for: $SAN"
