FROM --platform=linux/amd64 openresty/openresty:1.25.3.2-alpine

# Install lua-resty-http for topology service lookup in path-based routing.
# v0.17+ requires http_connect.lua in addition to http.lua and http_headers.lua.
RUN mkdir -p /usr/local/openresty/lualib/resty && \
    wget -q -O /usr/local/openresty/lualib/resty/http.lua \
      https://raw.githubusercontent.com/ledgetech/lua-resty-http/v0.17.2/lib/resty/http.lua && \
    wget -q -O /usr/local/openresty/lualib/resty/http_headers.lua \
      https://raw.githubusercontent.com/ledgetech/lua-resty-http/v0.17.2/lib/resty/http_headers.lua && \
    wget -q -O /usr/local/openresty/lualib/resty/http_connect.lua \
      https://raw.githubusercontent.com/ledgetech/lua-resty-http/v0.17.2/lib/resty/http_connect.lua

COPY nginx.conf /usr/local/openresty/nginx/conf/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
