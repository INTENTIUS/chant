FROM nginx:alpine
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
    listen 80;
    location / {
        return 200 'UI service healthy\n';
        add_header Content-Type text/plain;
    }
    location /health {
        return 200 'ok\n';
        add_header Content-Type text/plain;
    }
}
NGINX
EXPOSE 80
