#!/bin/sh
set -e
# Inject kube-dns IP into nginx resolver directive at runtime.
DNS=$(grep nameserver /etc/resolv.conf | awk '{print $2}' | head -1)
sed -i "s/KUBE_DNS_PLACEHOLDER/${DNS}/" /usr/local/openresty/nginx/conf/nginx.conf
exec /usr/local/openresty/bin/openresty -g "daemon off;"
